"""Sync vendors, projects (Customers or Classes) and items from QBO to local DB."""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.coding_option import CodingOption
from app.models.project import Project
from app.models.qbo_token import QboToken
from app.models.vendor import Vendor
from app.services import qbo_client, trusted_domains

log = logging.getLogger(__name__)


async def sync_vendors(session: AsyncSession) -> int:
    """Upsert every active vendor in QBO. Returns the count synced."""
    rows = await qbo_client.qbo_query(session, "SELECT * FROM Vendor")
    now = datetime.now(UTC)
    count = 0
    seen_qbo_ids: set[str] = set()
    for row in rows:
        qbo_id = str(row.get("Id"))
        if not qbo_id:
            continue
        seen_qbo_ids.add(qbo_id)
        display = row.get("DisplayName") or row.get("CompanyName") or "Unnamed"
        email = None
        if isinstance(row.get("PrimaryEmailAddr"), dict):
            email = row["PrimaryEmailAddr"].get("Address")
        active = bool(row.get("Active", True))

        existing = (
            await session.execute(select(Vendor).where(Vendor.qbo_id == qbo_id))
        ).scalar_one_or_none()
        if existing:
            existing.display_name = display
            existing.email = email
            existing.active = active
            existing.last_synced_at = now
        else:
            session.add(
                Vendor(
                    qbo_id=qbo_id,
                    display_name=display,
                    email=email,
                    active=active,
                    last_synced_at=now,
                )
            )
        count += 1

    await _deactivate_missing_vendors(session, seen_qbo_ids, now)

    # Mark the sync timestamp on the token row
    token = (await session.execute(select(QboToken).where(QboToken.id == 1))).scalar_one_or_none()
    if token:
        token.last_vendor_sync_at = now
    await session.flush()

    # Refresh the email-domain allowlist from the freshly-synced vendor
    # emails. Failures here are non-fatal — vendor sync should still
    # report success even if the allowlist update has a hiccup.
    try:
        report = await trusted_domains.sync_from_vendor_emails(session)
        log.info(
            "Trusted domains refreshed from vendor emails: added=%d kept=%d removed=%d",
            report["added"],
            report["kept"],
            report["removed"],
        )
    except Exception:  # noqa: BLE001
        log.exception("Trusted-domain refresh failed during vendor sync")

    log.info("Synced %d vendors from QBO", count)
    return count


async def sync_projects(session: AsyncSession) -> int:
    """Sync projects from either Customers (default) or Classes.

    The project_source setting on QboToken determines which. "Customer" uses sub-
    customers, and "Class" uses QBO Classes. A Customer has `Id` / `DisplayName` /
    `ParentRef.value` / `Active`. A Class has `Id` / `Name` / `ParentRef.value` /
    `Active`.
    """
    token = (await session.execute(select(QboToken).where(QboToken.id == 1))).scalar_one_or_none()
    source = (token.project_source if token else "Customer") or "Customer"

    if source == "Class":
        rows = await qbo_client.qbo_query(session, "SELECT * FROM Class")
        qbo_type = "Class"

        def display(r: dict[str, Any]) -> str:
            return r.get("Name") or r.get("FullyQualifiedName") or "Unnamed"
    else:
        rows = await qbo_client.qbo_query(session, "SELECT * FROM Customer")
        qbo_type = "Customer"

        def display(r: dict[str, Any]) -> str:
            return r.get("DisplayName") or r.get("CompanyName") or "Unnamed"

    now = datetime.now(UTC)
    count = 0
    seen_qbo_ids: set[str] = set()
    for row in rows:
        qbo_id = str(row.get("Id"))
        if not qbo_id:
            continue
        seen_qbo_ids.add(qbo_id)
        parent: str | None = None
        if isinstance(row.get("ParentRef"), dict):
            parent = row["ParentRef"].get("value")
        active = bool(row.get("Active", True))

        existing = (
            await session.execute(select(Project).where(Project.qbo_id == qbo_id))
        ).scalar_one_or_none()
        if existing:
            existing.display_name = display(row)
            existing.qbo_type = qbo_type
            existing.parent_qbo_id = parent
            existing.active = active
            existing.last_synced_at = now
        else:
            session.add(
                Project(
                    qbo_id=qbo_id,
                    qbo_type=qbo_type,
                    display_name=display(row),
                    parent_qbo_id=parent,
                    active=active,
                    last_synced_at=now,
                )
            )
        count += 1

    await _deactivate_missing_projects(session, seen_qbo_ids, now)

    if token:
        token.last_project_sync_at = now
    await session.flush()
    log.info("Synced %d projects (%s) from QBO", count, qbo_type)
    return count


# ---------- Items (Products/Services) -> cost codes ----------


async def fetch_items(session: AsyncSession) -> list[dict[str, Any]]:
    """Active QBO Items, slimmed to what the picker and the matcher need."""
    rows = await qbo_client.qbo_query(session, "SELECT * FROM Item")
    return [
        {
            "id": str(r.get("Id")),
            "name": r.get("Name") or "",
            "fully_qualified_name": r.get("FullyQualifiedName") or r.get("Name") or "",
        }
        for r in rows
        if r.get("Id") and r.get("Active", True)
    ]


def normalise_code(value: str) -> str:
    """Fold a cost code for comparison: case, letter-O vs zero, punctuation.

    The Controller's screenshots show ``01-520.0`` (zero) in the portal
    against ``01-520.O`` (letter O) in QBO, and the portal also carries
    forms like ``01-520 "O"``. All of those must compare equal.
    """
    return re.sub(r"[^a-z0-9]", "", value.lower().replace("o", "0"))


def match_item(value: str, items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the item whose Name matches a cost code, or None.

    Exact (normalised) match wins; otherwise a unique prefix match, since
    QBO item names carry a description after the code ("01-520.O Temp
    Toilet"). Ambiguous prefixes are logged and skipped rather than guessed.
    """
    key = normalise_code(value)
    if len(key) < 3:
        return None
    exact = [i for i in items if normalise_code(i["name"]) == key]
    if len(exact) == 1:
        return exact[0]
    prefix = exact or [i for i in items if normalise_code(i["name"]).startswith(key)]
    if len(prefix) == 1:
        return prefix[0]
    if prefix:
        log.warning(
            "Cost code %r matches %d QBO items, not mapping: %s",
            value,
            len(prefix),
            [i["fully_qualified_name"] for i in prefix],
        )
    return None


async def sync_items(session: AsyncSession) -> dict[str, int]:
    """Map cost-code options to QBO Items by name.

    Only fills rows that have no mapping yet (manual picks in Settings are
    never overwritten); already-mapped rows just get their display name
    refreshed. Returns counts for the UI.
    """
    items = await fetch_items(session)
    by_id = {i["id"]: i for i in items}
    rows = (
        await session.execute(select(CodingOption).where(CodingOption.field == "cost_code"))
    ).scalars().all()
    mapped = unmapped = 0
    for row in rows:
        if row.qbo_item_id:
            if row.qbo_item_id in by_id:
                row.qbo_item_name = by_id[row.qbo_item_id]["fully_qualified_name"]
            else:
                log.warning(
                    "Cost code %r is mapped to QBO item %s, which is gone or inactive",
                    row.value,
                    row.qbo_item_id,
                )
        else:
            item = match_item(row.value, items)
            if item:
                row.qbo_item_id = item["id"]
                row.qbo_item_name = item["fully_qualified_name"]
        if row.qbo_item_id:
            mapped += 1
        else:
            unmapped += 1
    await session.flush()
    log.info(
        "Item sync: %d QBO items, %d cost codes mapped, %d unmapped", len(items), mapped, unmapped
    )
    return {"items": len(items), "mapped": mapped, "unmapped": unmapped}


async def _deactivate_missing_vendors(
    session: AsyncSession,
    seen_qbo_ids: set[str],
    now: datetime,
) -> None:
    rows = (await session.execute(select(Vendor).where(Vendor.qbo_id.is_not(None)))).scalars().all()
    for vendor in rows:
        if vendor.qbo_id not in seen_qbo_ids:
            vendor.active = False
            vendor.last_synced_at = now


async def _deactivate_missing_projects(
    session: AsyncSession,
    seen_qbo_ids: set[str],
    now: datetime,
) -> None:
    rows = (await session.execute(select(Project).where(Project.qbo_id.is_not(None)))).scalars().all()
    for project in rows:
        if project.qbo_id not in seen_qbo_ids:
            project.active = False
            project.last_synced_at = now
