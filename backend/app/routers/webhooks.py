"""Inbound email webhooks — Postmark and Resend.

Both providers funnel into the same downstream logic via
``_process_inbound_email``: dedup by message id, render body-only emails,
detect encrypted PDFs, upload to R2, audit-log, and queue extraction.
The provider-specific routes only differ in:

  - Auth scheme (Postmark = Basic Auth, Resend = Svix HMAC)
  - Payload shape parsing (Resend webhook is metadata-only;
    we have to call back to its API to fetch text/html + attachment
    binaries)

Keep both endpoints live during the cutover so we can flip back if
Resend has any issue. After verification we can drop the Postmark
endpoint + ``POSTMARK_WEBHOOK_SECRET`` in a follow-up.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models.invoice import Invoice, InvoiceStatus, TriageReason
from app.services import (
    audit,
    email_auth,
    email_render,
    extraction,
    pdf_inspect,
    postmark,
    resend_inbound,
    storage,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["webhooks"])


# ---------------------------------------------------------------------------
# Pre-flight helpers (asyncio.to_thread wrappers)
# ---------------------------------------------------------------------------

async def _safe_page_count(content: bytes, filename: str) -> int | None:
    """Best-effort page count off the event loop."""
    count = await asyncio.to_thread(pdf_inspect.page_count, content)
    if count is None:
        log.warning("pypdf could not read inbound %s", filename)
    return count


async def _safe_is_encrypted(content: bytes) -> bool:
    """Off-loop encryption check."""
    return await asyncio.to_thread(pdf_inspect.is_encrypted, content)


# ---------------------------------------------------------------------------
# Postmark inbound
# ---------------------------------------------------------------------------


@router.post("/postmark", status_code=status.HTTP_200_OK)
async def postmark_inbound(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    settings = get_settings()

    if not postmark.verify_basic_auth(authorization, settings.postmark_webhook_secret):
        raise HTTPException(status_code=401, detail="Invalid webhook credentials")

    try:
        payload: dict[str, Any] = await request.json()
    except Exception as exc:
        log.warning("Postmark webhook body is not JSON: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc

    message_id: str | None = payload.get("MessageID") or payload.get("MessageId")
    if not message_id:
        log.warning("Postmark webhook missing MessageID — accepting but not deduping")

    # Dedup
    if message_id and await _is_duplicate(session, message_id):
        log.info("Duplicate Postmark MessageID %s — ignoring", message_id)
        return {"status": "duplicate", "message_id": message_id}

    received_at = postmark.parse_received_at(payload.get("Date"))
    sender: str | None = payload.get("From")
    if isinstance(payload.get("FromFull"), dict):
        sender = payload["FromFull"].get("Email") or sender
    subject: str | None = payload.get("Subject")
    body_text: str | None = payload.get("TextBody")
    body_html: str | None = payload.get("HtmlBody")
    attachments = postmark.extract_pdf_attachments(payload.get("Attachments") or [])

    return await _process_inbound_email(
        session=session,
        background=background,
        provider="postmark",
        message_id=message_id,
        sender=sender,
        subject=subject,
        body_text=body_text,
        body_html=body_html,
        received_at=received_at,
        attachments=attachments,
        auth=email_auth.summarize(payload.get("Headers")),
    )


# ---------------------------------------------------------------------------
# Resend inbound
# ---------------------------------------------------------------------------


@router.post("/resend", status_code=status.HTTP_200_OK)
async def resend_inbound_webhook(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    background: BackgroundTasks,
    svix_id: Annotated[str | None, Header(alias="svix-id")] = None,
    svix_timestamp: Annotated[str | None, Header(alias="svix-timestamp")] = None,
    svix_signature: Annotated[str | None, Header(alias="svix-signature")] = None,
) -> dict[str, Any]:
    """Resend Inbound webhook handler.

    The webhook itself only carries metadata. We verify the Svix
    signature, then call back to Resend's REST API to fetch the email
    body (text + html) and download each attachment binary before
    handing off to the shared processing flow.
    """
    settings = get_settings()

    raw_body = await request.body()

    if not resend_inbound.verify_signature(
        secret=settings.resend_webhook_secret,
        svix_id=svix_id,
        svix_timestamp=svix_timestamp,
        svix_signature=svix_signature,
        raw_body=raw_body,
    ):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        event: dict[str, Any] = await request.json()
    except Exception as exc:
        log.warning("Resend webhook body is not JSON: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc

    event_type = event.get("type")
    if event_type != "email.received":
        # Ignore other Resend event types (sent, delivered, bounced, …)
        # without erroring — Resend may share one webhook URL across
        # multiple subscribed events.
        log.debug("Ignoring Resend event type=%r", event_type)
        return {"status": "ignored", "type": event_type}

    data = event.get("data") or {}
    email_id: str | None = data.get("email_id")
    if not email_id:
        raise HTTPException(status_code=400, detail="Missing data.email_id")

    # Dedup on Resend's email_id (UUID).
    if await _is_duplicate(session, email_id):
        log.info("Duplicate Resend email_id %s — ignoring", email_id)
        return {"status": "duplicate", "email_id": email_id}

    sender = resend_inbound.parse_sender_email(data.get("from"))
    subject = data.get("subject")
    received_at = resend_inbound.parse_received_at(data.get("created_at"))

    # Fetch body text + html. If the API roundtrip fails, return 500 so
    # Resend retries (idempotent because we dedup by email_id).
    try:
        content = await resend_inbound.fetch_email_content(
            settings.resend_api_key, email_id
        )
    except resend_inbound.ResendInboundError as exc:
        log.exception("Resend fetch_email_content failed for %s", email_id)
        raise HTTPException(status_code=502, detail=f"Resend API: {exc}") from exc

    # Fetch attachments. Per-attachment failures are logged and skipped
    # inside fetch_attachments — only an outer 4xx/5xx raises here.
    try:
        all_attachments = await resend_inbound.fetch_attachments(
            settings.resend_api_key, email_id
        )
    except resend_inbound.ResendInboundError as exc:
        log.exception("Resend fetch_attachments failed for %s", email_id)
        raise HTTPException(status_code=502, detail=f"Resend API: {exc}") from exc

    pdfs = resend_inbound.filter_pdfs(all_attachments)
    if all_attachments and not pdfs:
        log.info(
            "Resend email %s had %d attachments but none are PDFs (%s)",
            email_id,
            len(all_attachments),
            [a.content_type for a in all_attachments],
        )
    attachments = [(a.filename, a.content) for a in pdfs]

    return await _process_inbound_email(
        session=session,
        background=background,
        provider="resend",
        message_id=email_id,
        sender=sender,
        subject=subject,
        body_text=content.text,
        body_html=content.html,
        received_at=received_at,
        attachments=attachments,
        auth=email_auth.summarize(content.headers),
    )


# ---------------------------------------------------------------------------
# Shared processing flow
# ---------------------------------------------------------------------------


async def _is_duplicate(session: AsyncSession, message_id: str) -> bool:
    existing = (
        await session.execute(
            select(Invoice.id).where(Invoice.email_message_id == message_id)
        )
    ).first()
    return existing is not None


async def _process_inbound_email(
    *,
    session: AsyncSession,
    background: BackgroundTasks,
    provider: str,
    message_id: str | None,
    sender: str | None,
    subject: str | None,
    body_text: str | None,
    body_html: str | None,
    received_at: datetime,
    attachments: list[tuple[str, bytes]],
    auth: str | None = None,
) -> dict[str, Any]:
    """Run a normalized inbound email through the ingestion pipeline.

    ``provider`` is just for logging — the routing logic is identical
    across providers. ``auth`` is the SPF/DKIM/DMARC summary (see
    ``email_auth.summarize``); extraction routes hard fails to triage.
    """
    body = body_text or body_html

    # Path A — no PDF attachments.
    if not attachments:
        rendered_payload = (body_text or body_html or "").strip()
        if rendered_payload:
            return await _ingest_body_only(
                session=session,
                background=background,
                provider=provider,
                message_id=message_id,
                sender=sender,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
                received_at=received_at,
                auth=auth,
            )
        return await _record_rejected_no_pdf(
            session=session,
            provider=provider,
            message_id=message_id,
            sender=sender,
            subject=subject,
            body=body,
            received_at=received_at,
        )

    # Path B — at least one PDF attachment.
    created: list[str] = []
    for idx, (filename, content) in enumerate(attachments):
        # For multi-PDF emails we suffix the dedup key so each row stays unique.
        dedup_id = message_id if len(attachments) == 1 else f"{message_id}:{idx}"

        invoice_id = await _ingest_pdf_attachment(
            session=session,
            background=background,
            dedup_id=dedup_id,
            sender=sender,
            subject=subject,
            body=body,
            received_at=received_at,
            filename=filename,
            content=content,
            auth=auth,
        )
        if invoice_id:
            created.append(str(invoice_id))

    await session.commit()
    log.info(
        "%s inbound processed: message=%s created=%d",
        provider.title(),
        message_id,
        len(created),
    )
    return {"status": "ok", "invoice_ids": created}


async def _ingest_pdf_attachment(
    *,
    session: AsyncSession,
    background: BackgroundTasks,
    dedup_id: str | None,
    sender: str | None,
    subject: str | None,
    body: str | None,
    received_at: datetime,
    filename: str,
    content: bytes,
    auth: str | None = None,
) -> UUID | None:
    """Upload one PDF, classify, and (if appropriate) queue extraction.

    Returns the new invoice id on success, or ``None`` when a rejected
    stub was added in place of a real ingestion (e.g. R2 upload failure).
    """
    page_count_value = await _safe_page_count(content, filename)
    encrypted = await _safe_is_encrypted(content)

    invoice_id = uuid4()
    key = storage.build_storage_key(invoice_id, received_at=received_at)
    try:
        await storage.upload_pdf(key, content, filename=filename)
    except Exception as exc:
        log.exception("R2 upload failed for inbound %s", filename)
        rejected = Invoice(
            id=invoice_id,
            source="email",
            sender_email=sender,
            email_subject=subject,
            email_body=body,
            email_message_id=dedup_id,
            received_at=received_at,
            pdf_storage_key="",
            pdf_filename=filename,
            pdf_size_bytes=len(content),
            pdf_page_count=page_count_value,
            status=InvoiceStatus.REJECTED,
            notes=f"Storage upload failed: {exc}",
        )
        session.add(rejected)
        return None

    if encrypted:
        # Skip extraction entirely — it would just fail. Land the row
        # directly in triage with a clear reason so AP knows to ask
        # the vendor for an unencrypted copy.
        invoice = Invoice(
            id=invoice_id,
            source="email",
            sender_email=sender,
            email_subject=subject,
            email_body=body,
            email_message_id=dedup_id,
            email_auth=auth,
            received_at=received_at,
            pdf_storage_key=key,
            pdf_filename=filename,
            pdf_size_bytes=len(content),
            pdf_page_count=page_count_value,
            status=InvoiceStatus.NEEDS_TRIAGE,
            triage_reason=TriageReason.ENCRYPTED_PDF,
            notes=(
                "PDF is password-protected. Ask the vendor to resend "
                "without encryption, or upload a decrypted copy manually."
            ),
        )
        session.add(invoice)
        await session.flush()
        await audit.record_system(
            session,
            action="triage_routed",
            invoice_id=invoice_id,
            message=f"reason=encrypted_pdf from={sender} filename={filename}",
        )
        return invoice_id

    invoice = Invoice(
        id=invoice_id,
        source="email",
        sender_email=sender,
        email_subject=subject,
        email_body=body,
        email_message_id=dedup_id,
        email_auth=auth,
        received_at=received_at,
        pdf_storage_key=key,
        pdf_filename=filename,
        pdf_size_bytes=len(content),
        pdf_page_count=page_count_value,
        status=InvoiceStatus.RECEIVED,
    )
    session.add(invoice)
    await session.flush()
    await audit.record_system(
        session,
        action="email_received",
        invoice_id=invoice_id,
        message=f"from={sender} auth={auth} subject={subject!r} filename={filename}",
    )
    background.add_task(extraction.extract_invoice, invoice_id)
    return invoice_id


async def _ingest_body_only(
    *,
    session: AsyncSession,
    background: BackgroundTasks,
    provider: str,
    message_id: str | None,
    sender: str | None,
    subject: str | None,
    body_text: str | None,
    body_html: str | None,
    received_at: datetime,
    auth: str | None = None,
) -> dict[str, Any]:
    """Render the email body to a PDF and treat it as a normal inbound.

    Pre-flights ``triage_reason=BODY_RENDERED`` so even after a
    successful high-confidence extraction the row lands in triage —
    AP confirms our reading of a free-form email body before it
    becomes a real bill.
    """
    invoice_id = uuid4()
    body = body_text or body_html

    try:
        pdf_bytes = await asyncio.to_thread(
            email_render.render_body_to_pdf,
            sender=sender,
            subject=subject,
            received_at=received_at,
            body=body,
            filename_for_log=str(invoice_id),
        )
    except Exception as exc:
        log.exception("Body-only render failed; falling back to rejected stub")
        return await _record_rejected_no_pdf(
            session=session,
            provider=provider,
            message_id=message_id,
            sender=sender,
            subject=subject,
            body=body,
            received_at=received_at,
            note=f"Body-only render failed: {exc}",
        )

    filename = "email-body.pdf"
    key = storage.build_storage_key(invoice_id, received_at=received_at)
    try:
        await storage.upload_pdf(key, pdf_bytes, filename=filename)
    except Exception as exc:
        log.exception("R2 upload of rendered email body failed")
        return await _record_rejected_no_pdf(
            session=session,
            provider=provider,
            message_id=message_id,
            sender=sender,
            subject=subject,
            body=body,
            received_at=received_at,
            note=f"Rendered body upload failed: {exc}",
        )

    page_count_value = await _safe_page_count(pdf_bytes, filename)

    invoice = Invoice(
        id=invoice_id,
        source="email",
        sender_email=sender,
        email_subject=subject,
        email_body=body,
        email_message_id=message_id,
        email_auth=auth,
        received_at=received_at,
        pdf_storage_key=key,
        pdf_filename=filename,
        pdf_size_bytes=len(pdf_bytes),
        pdf_page_count=page_count_value,
        status=InvoiceStatus.RECEIVED,
        # Pre-flight reason — extraction's _route_after_extraction will
        # respect this for high-confidence invoices (still goes to
        # triage so a human verifies the rendered-from-body content)
        # and override with NON_INVOICE / LOW_CONFIDENCE if appropriate.
        triage_reason=TriageReason.BODY_RENDERED,
    )
    session.add(invoice)
    await session.flush()
    await audit.record_system(
        session,
        action="email_received",
        invoice_id=invoice_id,
        message=f"from={sender} auth={auth} subject={subject!r} filename={filename} (body-rendered)",
    )
    background.add_task(extraction.extract_invoice, invoice_id)
    await session.commit()
    log.info(
        "%s inbound (body-only): rendered email body → invoice %s, queued extraction",
        provider.title(),
        invoice_id,
    )
    return {"status": "ok", "invoice_ids": [str(invoice_id)], "body_rendered": True}


async def _record_rejected_no_pdf(
    *,
    session: AsyncSession,
    provider: str,
    message_id: str | None,
    sender: str | None,
    subject: str | None,
    body: str | None,
    received_at: datetime,
    note: str = "No PDF attachment in inbound email",
) -> dict[str, Any]:
    """Create a rejected stub for emails that have no usable content."""
    invoice_id = uuid4()
    rejected = Invoice(
        id=invoice_id,
        source="email",
        sender_email=sender,
        email_subject=subject,
        email_body=body,
        email_message_id=message_id,
        received_at=received_at,
        pdf_storage_key="",
        pdf_filename="",
        pdf_size_bytes=0,
        status=InvoiceStatus.REJECTED,
        notes=note,
    )
    session.add(rejected)
    await session.flush()
    await audit.record_system(
        session,
        action="email_rejected_no_pdf",
        invoice_id=invoice_id,
        message=f"from={sender} subject={subject!r}",
    )
    await session.commit()
    log.info(
        "%s inbound %s had no usable PDF — created rejected stub %s",
        provider.title(),
        message_id,
        invoice_id,
    )
    return {"status": "rejected_no_pdf", "invoice_id": str(invoice_id)}
