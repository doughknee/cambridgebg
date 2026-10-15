"""Post a reported-as-suspicious invoice to RelentNet's Discord.

Best-effort: the Report action must succeed for AP even when the
webhook is unset or Discord is down, so this never raises.
"""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings
from app.models.invoice import Invoice

log = logging.getLogger(__name__)


async def post_report(invoice: Invoice, *, reporter_email: str | None) -> bool:
    settings = get_settings()
    url = settings.discord_report_webhook_url
    if not url:
        log.info("DISCORD_REPORT_WEBHOOK_URL unset — report for %s not posted", invoice.id)
        return False

    def _f(name: str, value: object) -> dict:
        return {"name": name, "value": str(value or "—")[:1024], "inline": True}

    total = (
        f"{invoice.total_cents / 100:,.2f} {invoice.currency}"
        if invoice.total_cents is not None
        else None
    )
    payload = {
        "embeds": [
            {
                "title": f"Suspicious invoice reported: {invoice.vendor_name or 'unknown vendor'}",
                "url": f"{settings.app_base_url}/invoices/{invoice.id}",
                "color": 0xB91C1C,
                "fields": [
                    _f("Sender", invoice.sender_email),
                    _f("Subject", invoice.email_subject),
                    _f("Total", total),
                    _f("Email auth", invoice.email_auth),
                    _f("Triage reason", invoice.triage_reason.value if invoice.triage_reason else None),
                    _f("Reported by", reporter_email),
                ],
            }
        ]
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            log.warning("Discord report webhook returned %s: %s", resp.status_code, resp.text[:200])
            return False
        return True
    except Exception:  # noqa: BLE001
        log.exception("Discord report webhook failed for %s", invoice.id)
        return False
