"""triage_reason CHECK: allow auth_failed

REL-692 added TriageReason.AUTH_FAILED to the enum but the CHECK
constraint from 0009 still listed the original five values, so the
first SPF/DKIM/DMARC failure in production blew up the post-extraction
UPDATE (REL-708). Drop and recreate the constraint with the full list.

Keep this tuple equal to ``[m.value for m in TriageReason]``;
tests/test_sender_gate.py asserts it.

Revision ID: 0015_triage_reason_auth_failed
Revises: 0014_coding_option_qbo_item
Create Date: 2026-10-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0015_triage_reason_auth_failed"
down_revision: Union[str, None] = "0014_coding_option_qbo_item"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_TRIAGE_REASON_VALUES = (
    "non_invoice",
    "unknown_sender",
    "body_rendered",
    "encrypted_pdf",
    "low_confidence",
)
TRIAGE_REASON_VALUES = OLD_TRIAGE_REASON_VALUES + ("auth_failed",)

# 0009 passed an already-prefixed name through the ck_%(table)s_%(name)s
# naming convention, so the live constraint is double-prefixed.
_NAME = "ck_invoices_ck_invoices_triage_reason"


def _check(values: tuple[str, ...]) -> str:
    quoted = ",".join(f"'{v}'" for v in values)
    return f"CHECK (triage_reason IS NULL OR triage_reason IN ({quoted}))"


def upgrade() -> None:
    op.execute(f"ALTER TABLE invoices DROP CONSTRAINT IF EXISTS {_NAME}")
    op.execute(f"ALTER TABLE invoices ADD CONSTRAINT {_NAME} {_check(TRIAGE_REASON_VALUES)}")


def downgrade() -> None:
    op.execute("UPDATE invoices SET triage_reason = NULL WHERE triage_reason = 'auth_failed'")
    op.execute(f"ALTER TABLE invoices DROP CONSTRAINT IF EXISTS {_NAME}")
    op.execute(f"ALTER TABLE invoices ADD CONSTRAINT {_NAME} {_check(OLD_TRIAGE_REASON_VALUES)}")
