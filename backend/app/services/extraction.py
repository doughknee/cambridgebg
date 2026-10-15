"""Invoice field extraction via Claude vision.

Pipeline:
  1. Mark invoice EXTRACTING.
  2. Download PDF from R2.
  3. Render first N pages to PNGs (cap at 4 for cost control).
  4. Call Claude messages API with vision + extraction prompt.
  5. Parse JSON, validate with ExtractedFields.
  6. Fuzzy-match vendor name to an existing Vendor row (case-insensitive).
  7. Persist, set status READY_FOR_REVIEW.
  8. On any failure: set EXTRACTION_FAILED with error message, audit.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pypdf
from anthropic import APIConnectionError as AnthropicAPIConnectionError
from anthropic import APIStatusError as AnthropicAPIStatusError
from anthropic import APITimeoutError as AnthropicAPITimeoutError
from anthropic import AsyncAnthropic
from anthropic import RateLimitError as AnthropicRateLimitError
from openai import APIConnectionError as OpenAIAPIConnectionError
from openai import APIStatusError as OpenAIAPIStatusError
from openai import APITimeoutError as OpenAIAPITimeoutError
from openai import AsyncOpenAI
from openai import RateLimitError as OpenAIRateLimitError
from pdf2image import convert_from_bytes
from PIL import Image
from rapidfuzz import fuzz
from rapidfuzz import process as fuzz_process
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import AsyncSessionLocal
from app.models.invoice import DocumentType, Invoice, InvoiceStatus, TriageReason
from app.models.vendor import Vendor
from app.prompts.invoice_extraction import EXTRACTION_PROMPT
from app.schemas.invoice import ExtractedFields
from app.services import audit, email_auth, storage, trusted_domains

log = logging.getLogger(__name__)

# How many pages we send to Claude per invoice. Most vendor invoices are
# 1–8 pages. When a PDF is longer we fall back to a "front + trailer"
# sampling strategy because the totals (subtotal / tax / freight / grand
# total) almost always live on the last page or two.
MAX_PAGES = 8
# When the source document has more than MAX_PAGES, this is how many
# pages we always include from the trailing end so we don't miss totals.
TRAILER_PAGES = 2
TARGET_WIDTH_PX = 2048
# Output cap for Claude's JSON response. We're billed for actual tokens
# used, not the cap — so this is purely safety headroom for invoices
# with many line items + verbose descriptions. The Silvercote 34-line
# acknowledgement order can hit ~8K tokens; 16K leaves room for outliers.
MAX_TOKENS = 16384
# Cap simultaneous extractions to keep memory pressure predictable. Each
# render can spike to ~150–250MB during PDF→PNG conversion; running more
# than two at once on a small Coolify container often triggers OOM.
_EXTRACTION_SEMAPHORE = asyncio.Semaphore(2)


@dataclass(frozen=True)
class ExtractionProvider:
    name: str
    extract: callable


@dataclass(frozen=True)
class ExtractionResult:
    provider_name: str
    payload: dict[str, Any]


class ExtractionProvidersUnavailableError(RuntimeError):
    pass


async def extract_invoice(invoice_id: UUID) -> None:
    """Top-level entrypoint run in a BackgroundTask. Opens its own session."""
    async with _EXTRACTION_SEMAPHORE, AsyncSessionLocal() as session:
        try:
            await _run(session, invoice_id)
            await session.commit()
        except Exception as exc:
            log.exception("Extraction failed for %s", invoice_id)
            await session.rollback()
            # Record the failure on a fresh session so it persists
            async with AsyncSessionLocal() as s2:
                inv = await s2.get(Invoice, invoice_id)
                if inv:
                    inv.status = InvoiceStatus.EXTRACTION_FAILED
                    inv.extraction_error = str(exc)[:2000]
                    await audit.record_system(
                        s2,
                        action="extraction_failed",
                        invoice_id=invoice_id,
                        message=str(exc)[:2000],
                    )
                    await s2.commit()


async def _run(session: AsyncSession, invoice_id: UUID) -> None:
    invoice = await session.get(Invoice, invoice_id)
    if invoice is None:
        log.warning("Invoice %s not found for extraction", invoice_id)
        return

    if invoice.status not in {InvoiceStatus.RECEIVED, InvoiceStatus.EXTRACTION_FAILED}:
        log.info("Invoice %s already processed (status=%s)", invoice_id, invoice.status)
        return

    invoice.status = InvoiceStatus.EXTRACTING
    invoice.extraction_error = None
    await session.flush()
    await audit.record_system(
        session, action="extraction_started", invoice_id=invoice_id
    )

    pdf_bytes = await storage.download_pdf(invoice.pdf_storage_key)
    # _render_pages spawns poppler subprocesses + Pillow resize work that
    # would block the asyncio loop for 5–30s. asyncio.to_thread keeps it
    # off the event loop so requests served by the same process keep flowing.
    page_images = await asyncio.to_thread(_render_pages, pdf_bytes)
    if not invoice.pdf_page_count:
        invoice.pdf_page_count = len(page_images)

    result = await _try_extract_with_fallback(page_images)
    fields = ExtractedFields.model_validate(result.payload)

    # Match vendor
    vendor_id: UUID | None = None
    if fields.vendor_name:
        vendor_id = await _match_vendor(session, fields.vendor_name)

    invoice.vendor_name = fields.vendor_name
    invoice.vendor_id = vendor_id
    invoice.invoice_number = fields.invoice_number
    invoice.invoice_date = fields.invoice_date
    invoice.due_date = fields.due_date
    invoice.po_number = fields.po_number
    invoice.subtotal_cents = fields.subtotal_cents
    invoice.tax_cents = fields.tax_cents
    invoice.total_cents = fields.total_cents
    invoice.currency = fields.currency or "USD"
    invoice.notes = fields.notes
    invoice.line_items = [li.model_dump() for li in fields.line_items]
    # Cambridge AP coding markup (may all be null for un-coded invoices)
    invoice.job_number = fields.job_number
    invoice.cost_code = fields.cost_code
    invoice.coding_date = fields.coding_date
    invoice.approver = fields.approver
    invoice.document_type = fields.document_type

    # Routing decision — only high-confidence invoices from recognised,
    # authenticated senders skip triage.
    # See spec: docs/superpowers/specs/2026-04-30-email-triage-design.md.
    sender_trusted = invoice.source != "email" or await trusted_domains.is_trusted(
        session, invoice.sender_email
    )
    next_status, next_reason = _route_after_extraction(
        invoice, fields, sender_trusted=sender_trusted
    )
    invoice.status = next_status
    invoice.triage_reason = next_reason

    await audit.record_system(
        session,
        action="extraction_completed",
        invoice_id=invoice_id,
        after={
            "vendor_name": fields.vendor_name,
            "invoice_number": fields.invoice_number,
            "total_cents": fields.total_cents,
            "line_items": len(fields.line_items),
            "job_number": fields.job_number,
            "cost_code": fields.cost_code,
            "approver": fields.approver,
            "confidence": fields.confidence,
            "document_type": fields.document_type.value,
            "status": next_status.value,
            "triage_reason": next_reason.value if next_reason else None,
        },
        message=f"confidence={fields.confidence} type={fields.document_type.value}",
    )
    if next_status == InvoiceStatus.NEEDS_TRIAGE:
        await audit.record_system(
            session,
            action="triage_routed",
            invoice_id=invoice_id,
            message=f"reason={next_reason.value if next_reason else 'unknown'} "
            f"document_type={fields.document_type.value} "
            f"confidence={fields.confidence}",
        )
    log.info(
        "Extracted invoice %s (vendor=%s, total=%s, type=%s, status=%s)",
        invoice_id,
        fields.vendor_name,
        fields.total_cents,
        fields.document_type.value,
        next_status.value,
    )


def _route_after_extraction(
    invoice: Invoice, fields: ExtractedFields, *, sender_trusted: bool
) -> tuple[InvoiceStatus, TriageReason | None]:
    """Decide where the invoice goes after a successful extraction.

    Routing precedence (most-actionable reason wins when multiple apply):

      1. document_type != INVOICE  → NEEDS_TRIAGE / NON_INVOICE
      2. SPF/DKIM/DMARC hard fail  → NEEDS_TRIAGE / AUTH_FAILED
      3. sender not in allowlist   → NEEDS_TRIAGE / UNKNOWN_SENDER
         (hard gate since REL-692 — a convincing fake is exactly the
         case "trust the content" fails on)
      4. confidence != "high"      → NEEDS_TRIAGE / LOW_CONFIDENCE
      5. pre-flight BODY_RENDERED  → NEEDS_TRIAGE / BODY_RENDERED
      6. otherwise                 → READY_FOR_REVIEW
    """
    if fields.document_type != DocumentType.INVOICE:
        return InvoiceStatus.NEEDS_TRIAGE, TriageReason.NON_INVOICE

    if email_auth.is_failed(invoice.email_auth):
        return InvoiceStatus.NEEDS_TRIAGE, TriageReason.AUTH_FAILED

    if not sender_trusted:
        return InvoiceStatus.NEEDS_TRIAGE, TriageReason.UNKNOWN_SENDER

    if fields.confidence != "high":
        return InvoiceStatus.NEEDS_TRIAGE, TriageReason.LOW_CONFIDENCE

    # Body-rendered docs still ride through triage so AP can confirm we
    # read the email body correctly.
    if invoice.triage_reason == TriageReason.BODY_RENDERED:
        return InvoiceStatus.NEEDS_TRIAGE, TriageReason.BODY_RENDERED

    return InvoiceStatus.READY_FOR_REVIEW, None


def _select_pages(total_pages: int) -> list[int]:
    """Pick which pages to render and ship to Claude.

    Goal: never miss the page that carries the grand total. On vendor
    invoices the totals block sits at the very end. So:

    - total <= MAX_PAGES → render every page
    - total >  MAX_PAGES → render the first (MAX_PAGES − TRAILER_PAGES)
      pages + the last TRAILER_PAGES pages

    We expose the chosen page numbers so the caller can label the images
    with their real position in the source PDF when it talks to Claude.
    """
    if total_pages <= 0:
        return []
    if total_pages <= MAX_PAGES:
        return list(range(1, total_pages + 1))

    front_count = MAX_PAGES - TRAILER_PAGES
    front = list(range(1, front_count + 1))
    tail = list(range(total_pages - TRAILER_PAGES + 1, total_pages + 1))
    return front + tail


def _render_pages(pdf_bytes: bytes) -> list[tuple[int, int, bytes]]:
    """Render selected pages at TARGET_WIDTH_PX wide.

    Returns (page_number, total_pages, png_bytes) per rendered page.
    The page_number is 1-indexed against the source PDF — when we
    sample (front + trailer), there can be a gap in the numbers, and
    we surface it to Claude so the omission is explicit instead of
    silent.

    Runs in a worker thread (asyncio.to_thread) — never call directly
    from an async function. Renders one page at a time so peak memory
    stays bounded to a single page regardless of source length.
    """
    # Read total page count without doing any rendering.
    try:
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
    except Exception:  # noqa: BLE001
        # Fall back to sending whatever pdf2image happens to produce
        # for the first MAX_PAGES — better than failing extraction.
        total_pages = MAX_PAGES

    pages = _select_pages(total_pages)
    out: list[tuple[int, int, bytes]] = []

    for page_num in pages:
        # Render at 110 DPI — noticeable memory savings vs 150 DPI for
        # equivalent extraction quality, and we resample down to
        # TARGET_WIDTH_PX afterwards anyway.
        images: list[Image.Image] = convert_from_bytes(
            pdf_bytes,
            dpi=110,
            first_page=page_num,
            last_page=page_num,
            fmt="ppm",
        )
        if not images:
            continue
        img = images[0]
        try:
            if img.width > TARGET_WIDTH_PX:
                ratio = TARGET_WIDTH_PX / img.width
                new_size = (TARGET_WIDTH_PX, int(img.height * ratio))
                resized = img.resize(new_size, Image.Resampling.LANCZOS)
                img.close()
                img = resized
            if img.mode != "RGB":
                converted = img.convert("RGB")
                img.close()
                img = converted
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            out.append((page_num, total_pages, buf.getvalue()))
        finally:
            img.close()
    return out


async def _call_claude(page_images: list[tuple[int, int, bytes]]) -> dict[str, Any]:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=0)

    content: list[dict[str, Any]] = []
    rendered_pages = [pn for pn, _, _ in page_images]
    total_pages = page_images[0][1] if page_images else 0
    for page_num, total, png in page_images:
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(png).decode("ascii"),
                },
            }
        )
        content.append({"type": "text", "text": f"Page {page_num} of {total}"})
    # If we sampled (front + trailer) tell Claude which pages were
    # omitted so it doesn't try to reconstruct missing line items —
    # totals from the trailer should win against any partial sums.
    if rendered_pages and len(rendered_pages) < total_pages:
        omitted = sorted(set(range(1, total_pages + 1)) - set(rendered_pages))
        content.append(
            {
                "type": "text",
                "text": (
                    f"Note: pages {omitted} of this {total_pages}-page document "
                    "were not provided. Some line items are therefore not "
                    "visible. Use the totals printed on the trailing pages "
                    "(subtotal, tax, total) as the source of truth — do NOT "
                    "compute totals by summing only the line items you can see."
                ),
            }
        )
    content.append({"type": "text", "text": EXTRACTION_PROMPT})

    resp = await client.messages.create(
        model=settings.extraction_model,
        max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": content}],
    )

    text_parts = [block.text for block in resp.content if block.type == "text"]
    raw = "\n".join(text_parts).strip()
    return _parse_model_json(raw, provider_name="Anthropic")


async def _call_openai(page_images: list[tuple[int, int, bytes]]) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY not configured")

    client = AsyncOpenAI(api_key=settings.openai_api_key, max_retries=0)

    content: list[dict[str, Any]] = []
    rendered_pages = [pn for pn, _, _ in page_images]
    total_pages = page_images[0][1] if page_images else 0
    for page_num, total, png in page_images:
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}",
                    "detail": "high",
                },
            }
        )
        content.append({"type": "text", "text": f"Page {page_num} of {total}"})
    if rendered_pages and len(rendered_pages) < total_pages:
        omitted = sorted(set(range(1, total_pages + 1)) - set(rendered_pages))
        content.append(
            {
                "type": "text",
                "text": (
                    f"Note: pages {omitted} of this {total_pages}-page document "
                    "were not provided. Some line items are therefore not "
                    "visible. Use the totals printed on the trailing pages "
                    "(subtotal, tax, total) as the source of truth — do NOT "
                    "compute totals by summing only the line items you can see."
                ),
            }
        )
    content.append({"type": "text", "text": EXTRACTION_PROMPT})

    resp = await client.chat.completions.create(
        model=settings.openai_extraction_model,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": content}],
    )
    raw = (resp.choices[0].message.content or "").strip()
    if not raw:
        raise ValueError("OpenAI returned empty output")
    return _parse_model_json(raw, provider_name="OpenAI")


async def _try_extract_with_fallback(
    page_images: list[tuple[int, int, bytes]],
    *,
    providers: list[ExtractionProvider] | None = None,
    is_transient_error: callable | None = None,
    sleep: callable = asyncio.sleep,
    max_attempts: int = 3,
    base_delay_seconds: float = 1.0,
) -> ExtractionResult:
    providers = providers or _build_extraction_providers()
    if not providers:
        raise RuntimeError("No extraction providers configured")

    transient_check = is_transient_error or _is_transient_extraction_error
    failures: list[str] = []

    for provider in providers:
        last_exc: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                payload = await provider.extract(page_images)
                return ExtractionResult(provider_name=provider.name, payload=payload)
            except Exception as exc:
                last_exc = exc
                if not transient_check(exc):
                    raise
                if attempt == max_attempts:
                    break
                delay = base_delay_seconds * (2 ** (attempt - 1))
                log.warning(
                    "Extraction provider %s transient failure on attempt %s/%s: %s",
                    provider.name,
                    attempt,
                    max_attempts,
                    exc,
                )
                await _sleep(sleep, delay)

        if last_exc is not None:
            failures.append(f"{provider.name}: {last_exc}")
            log.warning(
                "Extraction provider %s exhausted after %s attempts; trying next provider",
                provider.name,
                max_attempts,
            )

    raise ExtractionProvidersUnavailableError(
        "All extraction providers unavailable: " + "; ".join(failures)
    )


def _build_extraction_providers() -> list[ExtractionProvider]:
    settings = get_settings()
    providers: list[ExtractionProvider] = []
    if settings.anthropic_api_key:
        providers.append(ExtractionProvider(name="anthropic", extract=_call_claude))
    if settings.openai_api_key:
        providers.append(ExtractionProvider(name="openai", extract=_call_openai))
    return providers


def _is_transient_extraction_error(exc: Exception) -> bool:
    if isinstance(
        exc,
        (
            AnthropicRateLimitError,
            AnthropicAPIConnectionError,
            AnthropicAPITimeoutError,
            OpenAIRateLimitError,
            OpenAIAPIConnectionError,
            OpenAIAPITimeoutError,
        ),
    ):
        return True
    if isinstance(exc, AnthropicAPIStatusError):
        return exc.status_code >= 500
    if isinstance(exc, OpenAIAPIStatusError):
        return exc.status_code >= 500
    return False


async def _sleep(sleeper: callable, delay_seconds: float) -> None:
    maybe_awaitable = sleeper(delay_seconds)
    if asyncio.iscoroutine(maybe_awaitable):
        await maybe_awaitable


def _parse_model_json(raw: str, *, provider_name: str) -> dict[str, Any]:
    # Strip code fences if the model slips and uses them
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].lstrip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as first_err:
        # Claude occasionally "shows its work" inline — emitting things
        # like `"tax_cents": 7.33 + 54.12` when an invoice splits the
        # tax into multiple components. Try to repair common patterns
        # before giving up.
        repaired = _repair_claude_json(raw)
        if repaired is not None:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        raise ValueError(
            f"{provider_name} returned non-JSON output: {first_err}\n---\n{raw[:500]}"
        ) from first_err


# Match `"some_key": <num> + <num> [+ <num> ...]` appearing as a JSON
# value, where each operand is an int or decimal. We capture the field
# name too because cents fields need different handling — see _eval.
_ARITH_EXPR = re.compile(
    r'(?P<key>"(?P<name>[^"]+)"\s*:\s*)'
    r"(?P<expr>-?\d+(?:\.\d+)?(?:\s*[+\-]\s*-?\d+(?:\.\d+)?)+)"
    r"(?=\s*[,}\]\n])"
)


def _repair_claude_json(raw: str) -> str | None:
    """Best-effort repair for common LLM JSON-emission bugs.

    Handles arithmetic expressions in numeric value positions — the
    most-frequent failure mode (Claude "shows its work" by writing e.g.
    `"tax_cents": 7.33 + 54.12` instead of computing the integer).

    Special-case: when the field name ends in `_cents` and any operand
    contains a decimal point, the operands are in dollars (Claude saw
    `$7.33 + $54.12` on the invoice and copied it verbatim into a cents
    field). Multiply the result by 100 and round to the nearest int so
    Pydantic's integer validation doesn't reject the float.

    Returns the repaired string, or None if nothing was changed (so the
    caller can surface the original parse error verbatim).
    """
    changed = False

    def _eval_match(m: re.Match[str]) -> str:
        nonlocal changed
        expr = m.group("expr")
        name = m.group("name")
        is_cents_field = name.endswith("_cents")
        operands_have_decimals = "." in expr
        try:
            # Tokenize into numbers + operators. We only allow + and -
            # so this is safe to evaluate without eval().
            tokens = re.split(r"\s*([+\-])\s*", expr.strip())
            total = float(tokens[0])
            i = 1
            while i < len(tokens):
                op = tokens[i]
                num = float(tokens[i + 1])
                total += num if op == "+" else -num
                i += 2

            if is_cents_field and operands_have_decimals:
                # Claude emitted dollars where cents was expected.
                value = round(total * 100)
            elif total == int(total):
                value = int(total)
            else:
                # Quantity/non-cents field with a decimal result —
                # preserve precision but cap to 4 decimal places.
                value = round(total, 4)

            changed = True
            return f"{m.group('key')}{value}"
        except Exception:  # noqa: BLE001
            return m.group(0)

    repaired = _ARITH_EXPR.sub(_eval_match, raw)
    return repaired if changed else None


async def _match_vendor(session: AsyncSession, vendor_name: str) -> UUID | None:
    """Case-insensitive fuzzy match against existing Vendor rows.

    Returns a vendor_id only when the best match scores >= 85; otherwise None
    so the PM can pick / create manually.
    """
    result = await session.execute(select(Vendor).where(Vendor.active.is_(True)))
    vendors = result.scalars().all()
    if not vendors:
        return None

    choices = {v.id: v.display_name for v in vendors}
    # token_set_ratio (not WRatio): a vendor name is a bag of words, and we want
    # a match only when the two names genuinely share words. WRatio's partial-
    # substring component over-scores unrelated names — e.g. it rated
    # "VannGo Luxury Mobile Restrooms & Portables (Outside Sales)" against
    # "Cathryne & David Hall" at 85.5, just over the cutoff, and silently
    # assigned the wrong vendor. token_set_ratio scores that pair ~28 while
    # keeping real matches (abbreviations, trailing "LLC", "(Outside Sales)")
    # comfortably in the 88–100 range.
    best = fuzz_process.extractOne(
        vendor_name,
        choices,
        scorer=fuzz.token_set_ratio,
    )
    if best is None:
        return None
    _name, score, vid = best  # rapidfuzz returns (choice, score, key)
    if score >= 85:
        return vid  # UUID
    return None
