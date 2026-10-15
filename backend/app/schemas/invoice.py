"""Invoice DTOs."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.invoice import DocumentType, InvoiceStatus, TriageReason


class LineItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    description: str
    quantity: float | None = None
    unit_price_cents: int | None = None
    amount_cents: int | None = None


class ExtractedFields(BaseModel):
    """Raw extraction payload from the LLM."""

    model_config = ConfigDict(extra="ignore")

    vendor_name: str | None = None
    vendor_address: str | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    po_number: str | None = None
    subtotal_cents: int | None = None
    tax_cents: int | None = None
    total_cents: int | None = None
    currency: str = "USD"
    line_items: list[LineItem] = Field(default_factory=list)
    notes: str | None = None
    confidence: Literal["high", "medium", "low"] = "medium"

    # Cambridge AP coding (markup added by AP team to the PDF — typed,
    # stamped, or handwritten in a corner box)
    job_number: str | None = None
    cost_code: str | None = None
    coding_date: date | None = None
    approver: str | None = None

    # Triage classification: tells the post-extraction router whether
    # this is actually an invoice or something else (statement / quote /
    # order_ack / receipt / supporting_doc / other / unknown). Used in
    # combination with `confidence` to decide READY_FOR_REVIEW vs
    # NEEDS_TRIAGE. Defaults to UNKNOWN so missing classifications
    # route to triage rather than silently masquerading as invoices.
    document_type: DocumentType = DocumentType.UNKNOWN


class _InvoiceBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime
    source: str
    sender_email: str | None = None
    email_subject: str | None = None
    # "spf=pass dkim=pass dmarc=fail"; None when the provider sent nothing.
    email_auth: str | None = None
    received_at: datetime
    pdf_filename: str
    pdf_size_bytes: int
    pdf_page_count: int | None = None
    status: InvoiceStatus
    extraction_error: str | None = None

    vendor_name: str | None = None
    vendor_id: UUID | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    subtotal_cents: int | None = None
    tax_cents: int | None = None
    total_cents: int | None = None
    currency: str = "USD"
    po_number: str | None = None
    notes: str | None = None
    line_items: list[LineItem] = Field(default_factory=list)

    # Cambridge AP coding markup
    job_number: str | None = None
    cost_code: str | None = None
    coding_date: date | None = None
    approver: str | None = None

    project_id: UUID | None = None

    reviewed_by: str | None = None
    reviewed_by_email: str | None = None
    reviewed_at: datetime | None = None

    qbo_bill_id: str | None = None
    qbo_posted_at: datetime | None = None
    qbo_post_error: str | None = None

    assigned_to_id: str | None = None
    assigned_to_email: str | None = None
    assigned_to_name: str | None = None
    assigned_at: datetime | None = None
    claimed_at: datetime | None = None

    stamp_position: dict | None = None

    # Triage routing
    document_type: DocumentType | None = None
    triage_reason: TriageReason | None = None


class InvoiceListItem(_InvoiceBase):
    """Summary fields for the queue list."""


class InvoiceDetail(_InvoiceBase):
    email_body: str | None = None
    pdf_url: str | None = None
    # Whether sender_email is in the trusted allowlist. None = not computed
    # (mutation responses) or not an email-sourced invoice.
    sender_trusted: bool | None = None


class InvoiceListResponse(BaseModel):
    invoices: list[InvoiceListItem]
    total: int
    page: int
    page_size: int


class InvoicePatch(BaseModel):
    """Editable fields on the review interface."""

    model_config = ConfigDict(extra="forbid")

    vendor_name: str | None = None
    vendor_id: UUID | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    subtotal_cents: int | None = None
    tax_cents: int | None = None
    total_cents: int | None = None
    currency: str | None = None
    po_number: str | None = None
    notes: str | None = None
    line_items: list[LineItem] | None = None
    project_id: UUID | None = None

    # Cambridge AP coding markup
    job_number: str | None = None
    cost_code: str | None = None
    coding_date: date | None = None
    approver: str | None = None

    # Stamp placement on the QBO attachment. Schema:
    # {x: float, y: float, width: float} where each is a fraction of
    # the page (0–1, top-anchored). Set to null to reset to default.
    stamp_position: dict | None = None


class RejectInvoiceRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1024)


class AssignInvoiceRequest(BaseModel):
    """Assign an invoice to a specific user for visibility.

    Does NOT gate permissions — anyone can still approve/reject. This is
    primarily for queue organization and personal accountability.
    """

    user_id: str = Field(min_length=1, max_length=256)
    user_email: str | None = Field(default=None, max_length=256)
    user_name: str | None = Field(default=None, max_length=256)
    # Whether to email the new assignee. Admins can assign quietly by sending
    # this false. Defaults true to preserve prior behaviour. The recipient's
    # own preference can still suppress the email even when this is true.
    notify: bool = True
