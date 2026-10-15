"""Summarise an inbound email's Authentication-Results header.

Both inbound providers hand us the raw headers (Resend as a dict,
Postmark as a list of ``{"Name", "Value"}``). We only keep the three
verdicts AP cares about, as a short string like ``"spf=pass dkim=pass
dmarc=fail"``. Missing header → ``None`` (treated as unknown, never as
a failure).
"""
from __future__ import annotations

import re
from typing import Any

_METHODS = ("spf", "dkim", "dmarc")
_VERDICT_RE = re.compile(r"\b(spf|dkim|dmarc)=([a-z]+)", re.IGNORECASE)


def _header_value(headers: Any, name: str) -> str | None:
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).lower() == name:
                return " ".join(value) if isinstance(value, list) else str(value)
    elif isinstance(headers, list):
        for item in headers:
            if isinstance(item, dict) and str(item.get("Name", "")).lower() == name:
                return str(item.get("Value", ""))
    return None


def summarize(headers: Any) -> str | None:
    """``"spf=pass dkim=pass dmarc=fail"`` or None when no header present."""
    raw = _header_value(headers, "authentication-results")
    if not raw:
        return None
    verdicts: dict[str, str] = {}
    for method, verdict in _VERDICT_RE.findall(raw):
        verdicts.setdefault(method.lower(), verdict.lower())
    parts = [f"{m}={verdicts[m]}" for m in _METHODS if m in verdicts]
    return " ".join(parts) or None


def is_failed(summary: str | None) -> bool:
    """True only on a hard ``fail`` (softfail / none / neutral don't count)."""
    return bool(summary) and "=fail" in summary
