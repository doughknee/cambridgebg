"""invoices.email_auth — SPF/DKIM/DMARC summary from the inbound provider

Revision ID: 0013_invoice_email_auth
Revises: 0012_qbo_token_nullable_auth
Create Date: 2026-10-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0013_invoice_email_auth"
down_revision: Union[str, None] = "0012_qbo_token_nullable_auth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "invoices",
        sa.Column("email_auth", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("invoices", "email_auth")
