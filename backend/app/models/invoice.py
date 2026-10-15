"""Invoice model — the central entity."""
from __future__ import annotations

import enum
from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class InvoiceStatus(str, enum.Enum):
    RECEIVED = "received"
    EXTRACTING = "extracting"
    EXTRACTION_FAILED = "extraction_failed"
    READY_FOR_REVIEW = "ready_for_review"
    NEEDS_TRIAGE = "needs_triage"
    APPROVED = "approved"
    POSTED_TO_QBO = "posted_to_qbo"
    REJECTED = "rejected"


class DocumentType(str, enum.Enum):
    """What kind of document this is, per Claude classification.

    Only `INVOICE` (with high confidence) belongs in the main review
    queue; everything else routes to triage so AP can decide whether
    to promote, reject, or trust the sender. Set by extraction; null
    on rows that pre-date this feature.
    """

    INVOICE = "invoice"
    STATEMENT = "statement"           # account summary, multiple invoices
    QUOTE = "quote"                   # not yet billable
    ORDER_ACK = "order_ack"           # order acknowledgement, not yet billable
    RECEIPT = "receipt"               # already paid, no AP action needed
    SUPPORTING_DOC = "supporting_doc" # cover letter, W-9, etc.
    OTHER = "other"
    UNKNOWN = "unknown"


class TriageReason(str, enum.Enum):
    """Why an invoice landed in NEEDS_TRIAGE rather than READY_FOR_REVIEW.

    Priority order (when multiple apply, the most actionable one wins):
    encrypted_pdf > non_invoice > auth_failed > unknown_sender >
    low_confidence > body_rendered.
    """

    NON_INVOICE = "non_invoice"
    UNKNOWN_SENDER = "unknown_sender"
    BODY_RENDERED = "body_rendered"
    ENCRYPTED_PDF = "encrypted_pdf"
    LOW_CONFIDENCE = "low_confidence"
    # SPF/DKIM/DMARC reported a hard fail on the inbound email.
    AUTH_FAILED = "auth_failed"


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True, default=uuid4)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Source
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # email | upload
    sender_email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    email_subject: Mapped[str | None] = mapped_column(String(512), nullable=True)
    email_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_message_id: Mapped[str | None] = mapped_column(
        String(256), unique=True, nullable=True, index=True
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Summary of the inbound email's Authentication-Results header, e.g.
    # "spf=pass dkim=pass dmarc=fail". NULL when the provider sent none.
    email_auth: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # PDF
    pdf_storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    pdf_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    pdf_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    pdf_page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Status
    # values_callable forces SQLAlchemy to store the enum *value* (e.g. "received")
    # instead of the *name* (e.g. "RECEIVED"). This matches the CHECK constraint
    # in the initial migration and keeps the stored strings human-readable.
    status: Mapped[InvoiceStatus] = mapped_column(
        SAEnum(
            InvoiceStatus,
            name="invoice_status",
            native_enum=False,
            length=32,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
        default=InvoiceStatus.RECEIVED,
        index=True,
    )
    extraction_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Extracted fields (editable by PM)
    vendor_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    vendor_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True
    )
    invoice_number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    subtotal_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    tax_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    total_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    po_number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    line_items: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)

    # Cambridge AP coding markup (typically written/stamped on the PDF by AP
    # before posting). All optional — extraction may miss them, PMs fill in
    # via the review form.
    job_number: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    cost_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    coding_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    approver: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Project assignment
    project_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )

    # Review
    reviewed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    reviewed_by_email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # QBO posting
    qbo_bill_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    qbo_posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    qbo_post_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Assignment + claim. Admins/owners can review any invoice; members act
    # only on invoices assigned to them. ``claimed_at`` is set when the
    # assignee opens it via "Claim & review" — a signal to admins that
    # they've taken ownership. Reset whenever the assignee changes.
    assigned_to_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    assigned_to_email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    assigned_to_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Per-invoice override for where the AP stamp gets placed on page 1
    # of the QBO attachment. NULL = use the default (top-right, 24pt
    # margin). Schema: {"x": float, "y": float, "width": float} — all
    # fractions of the page (top-anchored). See alembic 0008.
    stamp_position: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Triage routing — set by extraction or webhook pre-flight checks.
    # document_type=INVOICE + confidence=high → READY_FOR_REVIEW.
    # Anything else → NEEDS_TRIAGE with a reason. NULL on legacy rows.
    document_type: Mapped[DocumentType | None] = mapped_column(
        SAEnum(
            DocumentType,
            name="document_type",
            native_enum=False,
            length=24,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=True,
        index=True,
    )
    triage_reason: Mapped[TriageReason | None] = mapped_column(
        SAEnum(
            TriageReason,
            name="triage_reason",
            native_enum=False,
            length=24,
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=True,
    )
