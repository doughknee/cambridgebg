"""CRUD for the admin-managed AP coding dropdowns.

Routes:
  GET    /api/coding-options                  — list (any auth user)
  POST   /api/coding-options                  — create (admin+)
  PATCH  /api/coding-options/{id}             — update (admin+)
  DELETE /api/coding-options/{id}             — delete (admin+)

Read is open to any authenticated user because PMs need the dropdowns to
fill in invoice review forms. Writes are gated on admin+ via the same
role-rank logic used in /api/users.
"""
from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import CurrentUser, get_current_user
from app.models.coding_option import CODING_FIELD_VALUES, CodingOption
from app.routers.users import ROLE_RANK, _get_actor_role
from app.schemas.coding_option import (
    CodingOptionCreate,
    CodingOptionListResponse,
    CodingOptionOut,
    CodingOptionPatch,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["coding-options"])


async def _require_admin(actor: CurrentUser) -> None:
    role = await _get_actor_role(actor.id)
    if ROLE_RANK[role] < ROLE_RANK["admin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires admin role — you're {role}",
        )


@router.get("", response_model=CodingOptionListResponse)
async def list_coding_options(
    _user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    """Return all coding options grouped by field."""
    rows = (
        await session.execute(
            select(CodingOption).order_by(
                CodingOption.field, CodingOption.value
            )
        )
    ).scalars().all()
    return CodingOptionListResponse(
        options=[CodingOptionOut.model_validate(r) for r in rows],
    )


@router.post(
    "",
    response_model=CodingOptionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_coding_option(
    body: CodingOptionCreate,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    await _require_admin(user)
    if body.field not in CODING_FIELD_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"field must be one of {CODING_FIELD_VALUES}",
        )

    option = CodingOption(
        field=body.field,
        value=body.value.strip(),
        label=(body.label.strip() if body.label else None) or None,
        active=True,
    )
    session.add(option)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A {body.field} option with that value already exists",
        ) from None
    await session.commit()
    return CodingOptionOut.model_validate(option)


@router.patch("/{option_id}", response_model=CodingOptionOut)
async def patch_coding_option(
    option_id: UUID,
    body: CodingOptionPatch,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    await _require_admin(user)
    option = await session.get(CodingOption, option_id)
    if option is None:
        raise HTTPException(status_code=404, detail="Option not found")

    updates = body.model_dump(exclude_unset=True)
    if "value" in updates and updates["value"] is not None:
        option.value = updates["value"].strip()
    if "label" in updates:
        option.label = (
            updates["label"].strip() if updates["label"] else None
        ) or None
    if "active" in updates and updates["active"] is not None:
        option.active = updates["active"]
    if "qbo_item_id" in updates:
        option.qbo_item_id = updates["qbo_item_id"] or None
        option.qbo_item_name = (
            updates.get("qbo_item_name") or None if option.qbo_item_id else None
        )

    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A {option.field} option with that value already exists",
        ) from None
    await session.commit()
    return CodingOptionOut.model_validate(option)


@router.delete("/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_coding_option(
    option_id: UUID,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
):
    await _require_admin(user)
    option = await session.get(CodingOption, option_id)
    if option is None:
        # 404 vs 204: idempotent delete returns 204, hides existence.
        # Going with 204 for simplicity.
        return
    await session.delete(option)
    await session.commit()
