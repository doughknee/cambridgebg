"""REL-692: unknown senders and failed email auth are hard gates into
Triage; public mail providers are trusted per address, not per domain."""
from __future__ import annotations

import os
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test.db")

from app.models.audit_log import AuditLog
from app.models.invoice import DocumentType, Invoice, InvoiceStatus, TriageReason
from app.routers import invoices
from app.schemas.invoice import ExtractedFields
from app.services import email_auth, trusted_domains
from app.services.extraction import _route_after_extraction


def _invoice(**overrides) -> Invoice:
    base = dict(
        source="email",
        sender_email="billing@vendor.com",
        received_at=datetime.now(UTC),
        pdf_storage_key="k",
        pdf_filename="f.pdf",
        pdf_size_bytes=1,
        status=InvoiceStatus.EXTRACTING,
        line_items=[],
    )
    return Invoice(**{**base, **overrides})


def _fields(**overrides) -> ExtractedFields:
    base = dict(document_type=DocumentType.INVOICE, confidence="high", line_items=[])
    return ExtractedFields(**{**base, **overrides})


# ---- routing ---------------------------------------------------------------


def test_trusted_high_confidence_goes_to_review() -> None:
    assert _route_after_extraction(_invoice(), _fields(), sender_trusted=True) == (
        InvoiceStatus.READY_FOR_REVIEW,
        None,
    )


def test_unknown_sender_is_a_hard_gate() -> None:
    assert _route_after_extraction(_invoice(), _fields(), sender_trusted=False) == (
        InvoiceStatus.NEEDS_TRIAGE,
        TriageReason.UNKNOWN_SENDER,
    )


def test_auth_failure_beats_trusted_sender() -> None:
    inv = _invoice(email_auth="spf=pass dkim=pass dmarc=fail")
    assert _route_after_extraction(inv, _fields(), sender_trusted=True) == (
        InvoiceStatus.NEEDS_TRIAGE,
        TriageReason.AUTH_FAILED,
    )


def test_non_invoice_still_wins() -> None:
    fields = _fields(document_type=DocumentType.STATEMENT)
    assert _route_after_extraction(_invoice(), fields, sender_trusted=False)[1] is (
        TriageReason.NON_INVOICE
    )


# ---- trust key -------------------------------------------------------------


@pytest.mark.parametrize(
    ("sender", "key"),
    [
        ("billing@vendor.com", "vendor.com"),
        ("Bob <Bob@Gmail.com>", "bob@gmail.com"),
        ("gmail.com", None),
        ("garbage", None),
    ],
)
def test_trust_key(sender: str, key: str | None) -> None:
    assert trusted_domains.trust_key(sender) == key


# ---- auth summary ----------------------------------------------------------


def test_summarize_resend_dict_and_postmark_list() -> None:
    raw = "mx.example.com; spf=pass smtp.mailfrom=v.com; dkim=pass; dmarc=fail (p=reject)"
    assert email_auth.summarize({"Authentication-Results": raw}) == "spf=pass dkim=pass dmarc=fail"
    assert email_auth.summarize([{"Name": "authentication-results", "Value": raw}]) == (
        "spf=pass dkim=pass dmarc=fail"
    )
    assert email_auth.summarize({"Subject": "x"}) is None
    assert email_auth.is_failed("spf=softfail dkim=none") is False
    assert email_auth.is_failed("spf=pass dmarc=fail") is True
    assert email_auth.is_failed(None) is False


# ---- report endpoint -------------------------------------------------------


@pytest.mark.asyncio
async def test_report_rejects_and_posts_to_discord(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/report.db")
    async with engine.begin() as conn:
        await conn.run_sync(Invoice.__table__.create)
        await conn.run_sync(AuditLog.__table__.create)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    posted: list[str | None] = []

    async def fake_post(invoice: Invoice, *, reporter_email: str | None) -> bool:
        posted.append(reporter_email)
        return True

    async def fake_role(_uid: str) -> str:
        return "admin"

    async def fake_presign(_key: str) -> str:
        return "https://example.test/pdf"

    monkeypatch.setattr(invoices.discord_report, "post_report", fake_post)
    monkeypatch.setattr(invoices.logto_admin, "user_app_role", fake_role)
    monkeypatch.setattr(invoices.storage, "presign_url", fake_presign)

    async with factory() as session:
        inv = _invoice(status=InvoiceStatus.NEEDS_TRIAGE, triage_reason=TriageReason.UNKNOWN_SENDER)
        session.add(inv)
        await session.commit()

        user = SimpleNamespace(id="u1", email="nathan@example.com", name="Nathan")
        detail = await invoices.report_invoice(inv.id, user, session)

        assert detail.status == InvoiceStatus.REJECTED
        assert "[Reported as suspicious]" in (detail.notes or "")
        assert posted == ["nathan@example.com"]
