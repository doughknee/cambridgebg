"""QuickBooks Online OAuth, sync, and settings endpoints."""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.deps import CurrentUser, get_current_user
from app.models.audit_log import AuditLog
from app.schemas.qbo import QboAuthUrl, QboSettingsPatch, QboStatus
from app.services import audit, qbo_client, qbo_sync

log = logging.getLogger(__name__)
router = APIRouter(tags=["qbo"])

# How long an OAuth `state` stays valid between /connect and /callback. The
# round-trip through Intuit's consent screen is normally seconds; 30 minutes
# is a generous ceiling that still bounds the CSRF replay window.
OAUTH_STATE_TTL = timedelta(minutes=30)

# Warn the UI to reconnect this far ahead of refresh-token expiry. Intuit's
# refresh token lasts ~100 days and rolls forward on each use, so it only
# lapses after a long idle stretch — a few days' warning is plenty.
RECONNECT_WARNING_WINDOW = timedelta(days=3)


def _needs_reconnect(refresh_expires_at: datetime | None) -> bool:
    """True when the refresh token is missing, expired, or within the warning
    window — i.e. when a connected token can no longer be relied on to post."""
    if refresh_expires_at is None:
        return True
    exp = refresh_expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=UTC)
    return exp <= datetime.now(UTC) + RECONNECT_WARNING_WINDOW


async def _oauth_state_is_valid(session: AsyncSession, state: str | None) -> bool:
    """Confirm the callback's ``state`` matches one we recently issued.

    ``qbo_connect`` records every generated state as a ``qbo_oauth_initiated``
    audit entry. Requiring a recent match here defeats CSRF: an attacker can't
    forge a callback that connects the app to *their* QBO company without a
    valid, unguessable, recently-issued state.
    """
    if not state:
        return False
    cutoff = datetime.now(UTC) - OAUTH_STATE_TTL
    stmt = (
        select(AuditLog.id)
        .where(
            AuditLog.action == "qbo_oauth_initiated",
            AuditLog.message == state,
            AuditLog.created_at >= cutoff,
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


@router.get("/status", response_model=QboStatus)
async def qbo_status(
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    settings = get_settings()
    token = await qbo_client.get_stored_token(session)
    # A disconnected row is kept (to preserve config) but has null auth — treat
    # "connected" as "has an access token", not merely "row exists".
    if token is None or not token.access_token:
        return QboStatus(connected=False, environment=settings.qbo_environment)
    # Posting needs a default expense account, from the saved config or the env
    # fallback. Surface when neither is set so the UI can warn before a post
    # fails with "No default expense account configured".
    needs_expense_account = not (
        token.default_expense_account_id or settings.qbo_default_expense_account_id
    )
    return QboStatus(
        connected=True,
        environment=settings.qbo_environment,
        realm_id=token.realm_id,
        expires_at=token.expires_at,
        refresh_expires_at=token.refresh_expires_at,
        needs_reconnect=_needs_reconnect(token.refresh_expires_at),
        needs_expense_account=needs_expense_account,
        last_vendor_sync_at=token.last_vendor_sync_at,
        last_project_sync_at=token.last_project_sync_at,
        project_source=token.project_source or "Customer",
        default_expense_account_id=token.default_expense_account_id,
    )


@router.get("/connect", response_model=QboAuthUrl)
async def qbo_connect(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    settings = get_settings()
    if not settings.qbo_client_id or not settings.qbo_client_secret:
        raise HTTPException(status_code=400, detail="QBO client credentials are not configured")

    url, state = qbo_client.build_auth_url()
    # Persist state to the audit log so the callback can validate it
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="qbo_oauth_initiated",
        message=state,
    )
    await session.commit()
    return QboAuthUrl(url=url)


@router.get("/callback")
async def qbo_callback(
    session: Annotated[AsyncSession, Depends(get_session)],
    code: str | None = Query(None),
    state: str | None = Query(None),
    realmId: str | None = Query(None),  # noqa: N803 — Intuit sends this exact param name
    error: str | None = Query(None),
):
    settings = get_settings()
    # Always redirect back to the frontend regardless of outcome
    target = f"{settings.app_base_url}/settings"
    if error:
        log.warning("QBO OAuth callback returned error=%s", error)
        return RedirectResponse(url=f"{target}?qbo_error={error}", status_code=302)
    if not code or not realmId:
        return RedirectResponse(url=f"{target}?qbo_error=missing_params", status_code=302)
    if not await _oauth_state_is_valid(session, state):
        log.warning("QBO OAuth callback rejected: invalid or expired state")
        return RedirectResponse(url=f"{target}?qbo_error=invalid_state", status_code=302)

    try:
        payload = await qbo_client.exchange_code_for_token(code, realmId)
    except qbo_client.QboApiError:
        log.exception("QBO code exchange failed")
        return RedirectResponse(url=f"{target}?qbo_error=exchange_failed", status_code=302)

    await qbo_client.save_token(
        session,
        realm_id=realmId,
        access_token=payload["access_token"],
        refresh_token=payload["refresh_token"],
        expires_in=int(payload.get("expires_in", 3600)),
        x_refresh_token_expires_in=int(payload.get("x_refresh_token_expires_in", 8726400)),
    )
    await audit.record_system(
        session,
        action="qbo_connected",
        message=f"realm_id={realmId}",
    )
    await session.commit()
    log.info("QBO connected to realm %s", realmId)
    return RedirectResponse(url=f"{target}?qbo_connected=1", status_code=302)


@router.post("/disconnect")
async def qbo_disconnect(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    await qbo_client.revoke_token(session)
    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="qbo_disconnected",
    )
    await session.commit()
    return {"status": "disconnected"}


@router.patch("/settings")
async def qbo_settings(
    body: QboSettingsPatch,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    token = await qbo_client.get_stored_token(session)
    if token is None or not token.access_token:
        raise HTTPException(status_code=400, detail="QBO is not connected")
    updates = body.model_dump(exclude_unset=True)
    if "project_source" in updates:
        ps = updates["project_source"]
        if ps not in {"Customer", "Class"}:
            raise HTTPException(status_code=400, detail="project_source must be Customer or Class")
        before = token.project_source
        token.project_source = ps
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="qbo_project_source_changed",
            before={"project_source": before},
            after={"project_source": ps},
        )
    if "default_expense_account_id" in updates:
        account_id = updates["default_expense_account_id"] or None
        before = token.default_expense_account_id
        token.default_expense_account_id = account_id
        await audit.record(
            session,
            actor_id=user.id,
            actor_email=user.email,
            action="qbo_default_expense_account_changed",
            before={"default_expense_account_id": before},
            after={"default_expense_account_id": account_id},
        )
    await session.commit()
    return {"status": "ok"}


# ---------- Sync ----------


@router.post("/sync/vendors")
async def sync_vendors(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    try:
        count = await qbo_sync.sync_vendors(session)
    except qbo_client.QboNotConnectedError:
        raise HTTPException(status_code=400, detail="QBO is not connected") from None
    except qbo_client.QboApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="qbo_sync_vendors",
        message=f"count={count}",
    )
    await session.commit()
    return {"count": count}


@router.post("/sync/projects")
async def sync_projects(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    try:
        count = await qbo_sync.sync_projects(session)
    except qbo_client.QboNotConnectedError:
        raise HTTPException(status_code=400, detail="QBO is not connected") from None
    except qbo_client.QboApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="qbo_sync_projects",
        message=f"count={count}",
    )
    await session.commit()
    return {"count": count}


@router.post("/sync/items")
async def sync_items(
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Name-match cost-code options to QBO Products/Services."""
    try:
        counts = await qbo_sync.sync_items(session)
    except qbo_client.QboNotConnectedError:
        raise HTTPException(status_code=400, detail="QBO is not connected") from None
    except qbo_client.QboApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await audit.record(
        session,
        actor_id=user.id,
        actor_email=user.email,
        action="qbo_sync_items",
        message=f"items={counts['items']} mapped={counts['mapped']} unmapped={counts['unmapped']}",
    )
    await session.commit()
    return counts


@router.get("/items")
async def list_items(
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Active QBO Products/Services for the cost-code item picker on Settings."""
    try:
        items = await qbo_sync.fetch_items(session)
    except qbo_client.QboNotConnectedError:
        raise HTTPException(status_code=400, detail="QBO is not connected") from None
    except qbo_client.QboApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"items": sorted(items, key=lambda i: i["fully_qualified_name"])}


@router.get("/expense-accounts")
async def list_expense_accounts(
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Returns simplified account list for the expense-account picker on Settings."""
    try:
        accounts = await qbo_client.fetch_expense_accounts(session)
    except qbo_client.QboNotConnectedError:
        raise HTTPException(status_code=400, detail="QBO is not connected") from None
    except qbo_client.QboApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "accounts": [
            {
                "id": a.get("Id"),
                "name": a.get("Name"),
                "account_type": a.get("AccountType"),
                "account_sub_type": a.get("AccountSubType"),
            }
            for a in accounts
        ]
    }
