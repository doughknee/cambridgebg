"""CodingOption — admin-managed dropdown values for the AP coding stamp.

These are the predefined choices the team picks from when filling in the
Cambridge AP markup on each invoice (job number, cost code, approver).
Free-text custom values are still allowed in the form, but options give
PMs a curated list of correct codes to pick from and reduce typos.

The `coding_date` field is intentionally excluded — it's a calendar date,
not a categorical value.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base

# Allowed values for the `field` discriminator. Kept in sync with the
# CHECK constraint defined in the Alembic migration.
CODING_FIELD_VALUES: tuple[str, ...] = ("job_number", "cost_code", "approver")


class CodingOption(Base):
    __tablename__ = "coding_options"

    id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Which AP coding field this option populates: 'job_number',
    # 'cost_code', or 'approver'. Indexed so the dropdown query
    # (`WHERE field = ?`) is cheap.
    field: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    # The actual code that gets stamped onto the PDF (e.g. "25-11-04",
    # "01-520 \"O\"", "jwh"). Required.
    value: Mapped[str] = mapped_column(String(128), nullable=False)

    # Optional human-readable description shown alongside the value in the
    # dropdown (e.g. "Cambridge — Lobby Renovation"). Helps non-AP users
    # pick the right code. Stamp itself only uses `value`.
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)

    # Soft-delete: inactive options stop appearing in dropdowns but stay
    # available for historical-record lookup.
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # cost_code rows only: the QBO Product/Service (Item) this code posts to.
    # Filled by the item sync (name match) or picked manually in Settings.
    # Null means the bill line falls back to the default expense account.
    qbo_item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    qbo_item_name: Mapped[str | None] = mapped_column(String(256), nullable=True)

    __table_args__ = (
        # Lock down `field` to the three discriminator values.
        CheckConstraint(
            f"field IN ({','.join(repr(v) for v in CODING_FIELD_VALUES)})",
            name="ck_coding_options_field",
        ),
        # No two active options with the same (field, value).
        UniqueConstraint("field", "value", name="uq_coding_options_field_value"),
    )
