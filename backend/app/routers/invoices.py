"""Invoice endpoints: list, detail, upload, patch, approve, reject, retry."""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pypdf import PdfReader
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import CurrentUser, get_current_user
from app.models.invoice import Invoice, InvoiceStatus
from app.schemas.invoice import (
    AssignInvoiceRequest,
    InvoiceDetail,
    InvoiceListItem,
    InvoiceListResponse,
    InvoicePatch,
    RejectInvoiceRequest,
)
from app.services import (
    assignment_notify,
    audit,
    discord_report,
    extraction,
    logto_admin,
    storage,
    trusted_domains,
)
from app.services import notifications as notif

log = logging.getLogger(__name__)
router = APIRouter(tags=["invoices"])


# ---------- List ----------

@router.get("", response_model=InvoiceListResponse)
async def list_invoices(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    status_filter: Annotated[list[InvoiceStatus] | None, Query(alias="status")] = None,
    assigned: Annotated[str | None, Query(pattern="^(true|false|mine)$")] = None,
    q: str | None = None,
    job: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """List invoices with optional filters.

    `assigned` semantics:
      - "true"  → only invoices with an assignee (any user)
      - "false" → only unassigned invoices
      - "mine"  → assigned specifically to the current user
      - None    → no assignment filter
    """
    stmt = select(Invoice)
    count_stmt = select(func.count(Invoice.id))

    if status_filter:
        stmt = stmt.where(Invoice.status.in_(status_filter))
        count_stmt = count_stmt.where(Invoice.status.in_(status_filter))
    if assigned == "true":
        cond = Invoice.assigned_to_id.is_not(None)
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    elif assigned == "false":
        cond = Invoice.assigned_to_id.is_(None)
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    elif assigned == "mine":
        cond = Invoice.assigned_to_id == user.id
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if q:
        like = f"%{q.lower()}%"
        cond = or_(
            func.lower(Invoice.vendor_name).like(like),
            func.lower(Invoice.invoice_number).like(like),
            func.lower(Invoice.po_number).like(like),
            func.lower(Invoice.sender_email).like(like),
            func.lower(Invoice.job_number).like(like),
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if job:
        # Dedicated job-number filter — case-insensitive substring match.
        # Useful for the "all invoices for job 25-11-04" use case.
        job_like = f"%{job.lower()}%"
        job_cond = func.lower(Invoice.job_number).like(job_like)
        stmt = stmt.where(job_cond)
        count_stmt = count_stmt.where(job_cond)

    total = (await session.execute(count_stmt)).scalar_one()
    stmt = (
        stmt.order_by(desc(Invoice.received_at))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return InvoiceListResponse(
        invoices=[InvoiceListItem.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


# ---------- Detail ----------

@router.get("/{invoice_id}", response_model=InvoiceDetail)
async def get_invoice(
    invoice_id: UUID,
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return await _detail_with_pdf(invoice, session=session)


# ---------- PDF (signed URL) ----------

@router.get("/{invoice_id}/pdf")
async def get_invoice_pdf_url(
    invoice_id: UUID,
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    url = await storage.presign_url(invoice.pdf_storage_key)
    return {"url": url, "ttl_seconds": 900}


# ---------- PDF (inline content, same-origin via backend proxy) ----------
# We proxy PDF bytes through the backend so the react-pdf viewer can fetch
# them without hitting R2's CORS policy. Open-in-new-tab still uses the
# direct signed URL since a top-level navigation doesn't trigger CORS.

@router.get("/{invoice_id}/pdf/content")
async def get_invoice_pdf_content(
    invoice_id: UUID,
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    from fastapi.responses import Response

    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    try:
        content = await storage.download_pdf(invoice.pdf_storage_key)
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    safe_name = (invoice.pdf_filename or "invoice.pdf").replace('"', "")
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=60",
        },
    )


# ---------- Upload ----------

@router.post("", response_model=InvoiceDetail, status_code=status.HTTP_201_CREATED)
async def upload_invoice(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
    file: Annotated[UploadFile, File(...)],
):
    if file.content_type != "application/pdf":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Expected application/pdf, got {file.content_type}",
        )
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    # Best-effort page count. PdfReader parses the xref table which can be
    # slow on large PDFs, so push it to a worker thread to keep the loop free.
    page_count = await _safe_page_count(content)

    invoice_id = uuid4()
    key = storage.build_storage_key(invoice_id)
    try:
        await storage.upload_pdf(key, content, filename=file.filename or "invoice.pdf")
    except storage.StorageNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except storage.StorageBucketMissingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    invoice = Invoice(
        id=invoice_id,
        source="upload",
        sender_email=user.email,
        received_at=datetime.now(UTC),
        pdf_storage_key=key,
        pdf_filename=file.filename or "invoice.pdf",
        pdf_size_bytes=len(content),
        pdf_page_count=page_count,
        status=InvoiceStatus.RECEIVED,
    )
    session.add(invoice)
    await session.flush()
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_uploaded",
        invoice_id=invoice_id,
        message=f"filename={file.filename} size={len(content)}",
    )
    await session.commit()

    background.add_task(extraction.extract_invoice, invoice_id)

    detail = InvoiceDetail.model_validate(invoice)
    detail.pdf_url = await storage.presign_url(key)
    return detail


# ---------- Edit (PM corrections) ----------

@router.patch("/{invoice_id}", response_model=InvoiceDetail)
async def patch_invoice(
    invoice_id: UUID,
    patch: InvoicePatch,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Cannot edit invoice already posted to QBO")

    before = _snapshot(invoice)
    updates = patch.model_dump(exclude_unset=True)
    for key, value in updates.items():
        if key == "line_items" and value is not None:
            value = [li if isinstance(li, dict) else li.model_dump() for li in value]
        setattr(invoice, key, value)
    after = _snapshot(invoice)

    b_changed, a_changed = audit.diff(before, after)
    if b_changed or a_changed:
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="invoice_edited",
            invoice_id=invoice_id,
            before=b_changed,
            after=a_changed,
        )

    await session.commit()
    detail = InvoiceDetail.model_validate(invoice)
    detail.pdf_url = await storage.presign_url(invoice.pdf_storage_key)
    return detail


# ---------- Lifecycle transitions ----------
#
# Status transitions:
#
#   ready_for_review ──┬─► approved ──► posted_to_qbo
#                      └─► rejected
#
#   approved ──► posted_to_qbo      (manual post)
#   approved ──► ready_for_review   (unapprove, back to editing)
#
# Assignment is a workflow-signaling feature. Admins/owners review and approve
# any invoice directly; plain members can only act on invoices assigned to
# them, and "claim" them (set claimed_at) to signal they've taken ownership.


async def _require_admin(user: CurrentUser, *, action: str) -> None:
    role = await logto_admin.user_app_role(user.id) or "member"
    if role not in {"owner", "admin"}:
        raise HTTPException(
            status_code=403,
            detail=f"Only admins and owners can {action}",
        )


async def _require_assignment_manager(user: CurrentUser) -> None:
    await _require_admin(user, action="assign invoices")


async def _ensure_can_review(invoice: Invoice, user: CurrentUser, *, action: str) -> None:
    """Who may approve / post / unapprove an invoice.

    Admins and owners review and act on *any* invoice directly — they don't
    have to assign it to themselves first. Everyone else may only act on an
    invoice that's assigned to them.
    """
    role = await logto_admin.user_app_role(user.id) or "member"
    if role in {"owner", "admin"}:
        return
    if invoice.assigned_to_id != user.id:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Only an admin or the assigned user can {action}. "
                "Ask an admin to assign it to you if you need to handle it."
            ),
        )


async def _ensure_can_reject(invoice: Invoice, user: CurrentUser) -> None:
    """Who may reject an invoice: an admin/owner, or the user it's assigned to.

    Unassigned invoices (e.g. triage) are an admin responsibility, so a plain
    member can only reject invoices that are actually assigned to them.
    """
    role = await logto_admin.user_app_role(user.id) or "member"
    if role in {"owner", "admin"}:
        return
    if invoice.assigned_to_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="Only an admin or the assigned user can reject this invoice.",
        )


def _ensure_amounts_nonnegative(invoice: Invoice) -> None:
    """Reject negative money. ``_ensure_approvable``'s ``not total_cents`` test
    only catches a missing or zero total — a negative value is truthy and would
    otherwise sail through and post a negative bill to QBO.
    """
    negative = [
        name
        for name, cents in (
            ("total", invoice.total_cents),
            ("subtotal", invoice.subtotal_cents),
            ("tax", invoice.tax_cents),
        )
        if cents is not None and cents < 0
    ]
    if negative:
        raise HTTPException(
            status_code=400,
            detail=f"Amounts can't be negative: {', '.join(negative)}.",
        )


def _ensure_approvable(invoice: Invoice) -> None:
    """Raise 4xx if the invoice isn't in a state that can be approved."""
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Already posted to QBO")
    if invoice.status == InvoiceStatus.REJECTED:
        raise HTTPException(status_code=409, detail="Cannot approve a rejected invoice")
    if not invoice.vendor_name and not invoice.vendor_id:
        raise HTTPException(status_code=400, detail="Vendor is required before approval")
    if not invoice.total_cents:
        raise HTTPException(status_code=400, detail="Total amount is required before approval")
    _ensure_amounts_nonnegative(invoice)


def _ensure_postable(invoice: Invoice) -> None:
    """Raise 4xx if the invoice can't be posted to QBO yet.

    All four Cambridge AP coding fields must be filled in — the stamp
    that's baked into the QBO Bill attachment can't be generated
    otherwise. Approval doesn't require these (you can approve a vendor +
    total without coding), but posting does.
    """
    _ensure_amounts_nonnegative(invoice)
    missing = []
    if not (invoice.job_number or "").strip():
        missing.append("job number")
    if not (invoice.cost_code or "").strip():
        missing.append("cost code")
    if invoice.coding_date is None:
        missing.append("coding date")
    if not (invoice.approver or "").strip():
        missing.append("approver")
    if missing:
        joined = ", ".join(missing)
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cambridge AP coding incomplete — fill in {joined} "
                "before posting to QBO."
            ),
        )


def _mark_approved(invoice: Invoice, user: CurrentUser) -> None:
    invoice.status = InvoiceStatus.APPROVED
    invoice.reviewed_by = user.id
    invoice.reviewed_by_email = user.email
    invoice.reviewed_at = datetime.now(UTC)
    invoice.qbo_post_error = None


@router.post("/{invoice_id}/approve", response_model=InvoiceDetail)
async def approve_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Confirm the invoice is correct. Does NOT post to QBO — use /post next.

    Allowed from: ready_for_review, extraction_failed (fix-and-approve).
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await _ensure_can_review(invoice, user, action="approve")
    _ensure_approvable(invoice)

    _mark_approved(invoice, user)
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_approved",
        invoice_id=invoice_id,
    )
    await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/post", response_model=InvoiceDetail)
async def post_invoice_to_qbo(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
):
    """Enqueue QBO posting for an already-approved invoice.

    Idempotent — the background task will skip if the invoice is already
    posted. Also safe to retry after a prior failure.
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    # Posting to QBO is admin/owner-only. PMs code and approve; an approved
    # invoice waits in the Ready-to-Post queue for an admin to post it.
    await _require_admin(user, action="post invoices to QuickBooks")
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Already posted to QBO")
    if invoice.status != InvoiceStatus.APPROVED:
        raise HTTPException(
            status_code=409,
            detail="Only approved invoices can be posted. Approve it first.",
        )
    _ensure_postable(invoice)

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_post_requested",
        invoice_id=invoice_id,
    )
    await session.commit()

    from app.services import qbo_posting  # local import avoids circular at module load

    background.add_task(qbo_posting.post_bill, invoice_id)
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/approve-and-post", response_model=InvoiceDetail)
async def approve_and_post(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
):
    """Convenience endpoint: approve + enqueue post in one call.

    Admin/owner-only, because it posts. Members approve via /approve; posting
    is left to an admin from the Ready-to-Post queue.
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await _require_admin(user, action="post invoices to QuickBooks")
    _ensure_approvable(invoice)
    _ensure_postable(invoice)

    _mark_approved(invoice, user)
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_approved_and_post_requested",
        invoice_id=invoice_id,
    )
    await session.commit()

    from app.services import qbo_posting

    background.add_task(qbo_posting.post_bill, invoice_id)
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/unapprove", response_model=InvoiceDetail)
async def unapprove_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Revert an APPROVED invoice back to READY_FOR_REVIEW for more edits."""
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await _ensure_can_review(invoice, user, action="unapprove")
    if invoice.status != InvoiceStatus.APPROVED:
        raise HTTPException(
            status_code=409,
            detail="Only approved invoices can be unapproved",
        )

    invoice.status = InvoiceStatus.READY_FOR_REVIEW
    invoice.reviewed_by = None
    invoice.reviewed_by_email = None
    invoice.reviewed_at = None
    invoice.qbo_post_error = None
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_unapproved",
        invoice_id=invoice_id,
    )
    await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/assign", response_model=InvoiceDetail)
async def assign_invoice(
    invoice_id: UUID,
    body: AssignInvoiceRequest,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
):
    await _require_assignment_manager(user)
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    previous_assignee_id = invoice.assigned_to_id
    invoice.assigned_to_id = body.user_id
    invoice.assigned_to_email = body.user_email
    invoice.assigned_to_name = body.user_name
    invoice.assigned_at = datetime.now(UTC)
    # New assignee hasn't opened it yet — reset the claim signal.
    invoice.claimed_at = None
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_assigned",
        invoice_id=invoice_id,
        message=body.user_email or body.user_id,
    )
    await session.commit()

    # Best-effort email to the new assignee. Three gates must all pass:
    #   1. the admin didn't opt out of notifying for this assignment (body.notify)
    #   2. the assignment actually changed to someone other than the assigner
    #   3. the recipient hasn't turned assignment emails off in their prefs
    if (
        body.notify
        and assignment_notify.should_notify(
            new_assignee_id=body.user_id,
            previous_assignee_id=previous_assignee_id,
            actor_id=user.id,
            to_email=body.user_email,
        )
        and await notif.assignment_emails_allowed(session, body.user_id)
    ):
        background.add_task(
            assignment_notify.notify_assignment,
            invoice_id=invoice_id,
            to_email=body.user_email,
            to_name=body.user_name,
            actor_label=user.email or user.name or "A teammate",
        )

    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/unassign", response_model=InvoiceDetail)
async def unassign_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    await _require_assignment_manager(user)
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    prev = invoice.assigned_to_email or invoice.assigned_to_id
    invoice.assigned_to_id = None
    invoice.assigned_to_email = None
    invoice.assigned_to_name = None
    invoice.assigned_at = None
    invoice.claimed_at = None
    if prev:
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="invoice_unassigned",
            invoice_id=invoice_id,
            message=prev,
        )
    await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/claim", response_model=InvoiceDetail)
async def claim_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """The assignee marks an invoice as claimed — a signal to admins that
    they've opened it and taken ownership. Only the assignee may claim, and
    the call is idempotent (claiming an already-claimed invoice is a no-op).
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.assigned_to_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the assigned user can claim this invoice.",
        )
    if invoice.claimed_at is None:
        invoice.claimed_at = datetime.now(UTC)
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="invoice_claimed",
            invoice_id=invoice_id,
        )
        await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/reject", response_model=InvoiceDetail)
async def reject_invoice(
    invoice_id: UUID,
    body: RejectInvoiceRequest,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Cannot reject invoice already posted to QBO")
    await _ensure_can_reject(invoice, user)

    invoice.status = InvoiceStatus.REJECTED
    invoice.reviewed_by = user.id
    invoice.reviewed_by_email = user.email
    invoice.reviewed_at = datetime.now(UTC)
    invoice.notes = f"{invoice.notes or ''}\n\n[Rejection reason] {body.reason}".strip()

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_rejected",
        invoice_id=invoice_id,
        message=body.reason,
    )
    await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/reextract", response_model=InvoiceDetail)
async def reextract_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
):
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Cannot re-extract posted invoice")

    invoice.status = InvoiceStatus.RECEIVED
    invoice.extraction_error = None
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_reextract_requested",
        invoice_id=invoice_id,
    )
    await session.commit()
    background.add_task(extraction.extract_invoice, invoice_id)
    return await _detail_with_pdf(invoice)


# ---------- Triage actions ----------


@router.post("/{invoice_id}/promote", response_model=InvoiceDetail)
async def promote_from_triage(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Move an invoice from NEEDS_TRIAGE to READY_FOR_REVIEW.

    Used when the AP team confirms a triaged document is actually a
    real invoice that should be processed normally. Clears
    ``triage_reason`` since the row no longer needs explanation. The
    underlying ``document_type`` stays on the row so we can still
    show "promoted from triage" affordances later.
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status != InvoiceStatus.NEEDS_TRIAGE:
        raise HTTPException(
            status_code=409,
            detail=f"Invoice is in {invoice.status.value}, not needs_triage",
        )

    previous_reason = invoice.triage_reason.value if invoice.triage_reason else None
    invoice.status = InvoiceStatus.READY_FOR_REVIEW
    invoice.triage_reason = None
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="triage_promoted",
        invoice_id=invoice_id,
        message=f"reason={previous_reason}",
    )
    await session.commit()
    return await _detail_with_pdf(invoice)


@router.post("/{invoice_id}/trust-sender", response_model=InvoiceDetail)
async def trust_sender_and_promote(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Trust the sender's domain + promote the invoice in one click.

    Pulls the registrable domain from ``sender_email``, upserts it into
    ``trusted_sender_domains`` with source=``promoted_from_triage``,
    then routes the row to READY_FOR_REVIEW. If the row isn't in
    NEEDS_TRIAGE we still trust the domain (no harm, idempotent) but
    we don't change the status.

    Admin/owner only: trusting a domain auto-promotes *all* future mail
    from that domain, so it's a higher-trust action than promoting a
    single invoice (which any member can do via /promote).
    """
    await _require_admin(user, action="trust a sender domain")
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if not invoice.sender_email:
        raise HTTPException(
            status_code=400,
            detail="Invoice has no sender email — can't trust a domain",
        )

    # upsert_manual picks the trust key itself: registrable domain, or
    # the full address for public mail providers (gmail.com etc).
    try:
        row = await trusted_domains.upsert_manual(
            session,
            domain=invoice.sender_email,
            actor_id=user.id,
            actor_email=user.email,
            notes=f"Trusted via triage of invoice {invoice_id}",
            source="promoted_from_triage",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="sender_trusted",
        invoice_id=invoice_id,
        message=f"domain={row.domain} source={row.source}",
    )

    if invoice.status == InvoiceStatus.NEEDS_TRIAGE:
        previous_reason = invoice.triage_reason.value if invoice.triage_reason else None
        invoice.status = InvoiceStatus.READY_FOR_REVIEW
        invoice.triage_reason = None
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="triage_promoted",
            invoice_id=invoice_id,
            message=f"reason={previous_reason} via=trust-sender",
        )

    await session.commit()
    return await _detail_with_pdf(invoice, session=session)


@router.post("/{invoice_id}/report", response_model=InvoiceDetail)
async def report_invoice(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Reject as suspicious and forward the details to RelentNet.

    Same permission rule as /reject: admins, or the assignee. The
    Discord post is best-effort — the rejection stands either way.
    """
    invoice = await session.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice.status == InvoiceStatus.POSTED_TO_QBO:
        raise HTTPException(status_code=409, detail="Cannot report invoice already posted to QBO")
    await _ensure_can_reject(invoice, user)

    invoice.status = InvoiceStatus.REJECTED
    invoice.reviewed_by = user.id
    invoice.reviewed_by_email = user.email
    invoice.reviewed_at = datetime.now(UTC)
    invoice.notes = f"{invoice.notes or ''}\n\n[Reported as suspicious] by {user.email}".strip()

    posted = await discord_report.post_report(invoice, reporter_email=user.email)
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="invoice_reported",
        invoice_id=invoice_id,
        message=f"from={invoice.sender_email} auth={invoice.email_auth} discord={'sent' if posted else 'not_sent'}",
    )
    await session.commit()
    return await _detail_with_pdf(invoice)


# ---------- Legacy retry endpoint (kept for backward compatibility) ----------
# Equivalent to /post; will be removed once the frontend no longer calls it.


@router.post("/{invoice_id}/retry-qbo", response_model=InvoiceDetail)
async def retry_qbo(
    invoice_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
):
    return await post_invoice_to_qbo(invoice_id, user, session, background)


# ---------- Helpers ----------


async def _safe_page_count(content: bytes) -> int | None:
    """Page count via pypdf, off the event loop. Returns None if it fails."""
    import asyncio
    import io

    def _count() -> int | None:
        try:
            return len(PdfReader(io.BytesIO(content)).pages)
        except Exception as exc:  # noqa: BLE001
            log.warning("pdf page count failed: %s", exc)
            return None

    return await asyncio.to_thread(_count)


async def _detail_with_pdf(
    invoice: Invoice, *, session: AsyncSession | None = None
) -> InvoiceDetail:
    detail = InvoiceDetail.model_validate(invoice)
    try:
        detail.pdf_url = await storage.presign_url(invoice.pdf_storage_key)
    except Exception as exc:  # noqa: BLE001
        log.warning("presign_url failed for %s: %s", invoice.id, exc)
    # Only the GET endpoint pays for the allowlist lookup; mutation
    # responses leave it None and the page refetches.
    if session is not None and invoice.source == "email":
        detail.sender_trusted = await trusted_domains.is_trusted(session, invoice.sender_email)
    return detail


def _snapshot(invoice: Invoice) -> dict:
    return {
        "vendor_name": invoice.vendor_name,
        "vendor_id": str(invoice.vendor_id) if invoice.vendor_id else None,
        "invoice_number": invoice.invoice_number,
        "invoice_date": invoice.invoice_date.isoformat() if invoice.invoice_date else None,
        "due_date": invoice.due_date.isoformat() if invoice.due_date else None,
        "subtotal_cents": invoice.subtotal_cents,
        "tax_cents": invoice.tax_cents,
        "total_cents": invoice.total_cents,
        "currency": invoice.currency,
        "po_number": invoice.po_number,
        "notes": invoice.notes,
        "line_items": invoice.line_items,
        "project_id": str(invoice.project_id) if invoice.project_id else None,
        # Cambridge AP coding markup
        "job_number": invoice.job_number,
        "cost_code": invoice.cost_code,
        "coding_date": invoice.coding_date.isoformat() if invoice.coding_date else None,
        "approver": invoice.approver,
    }
