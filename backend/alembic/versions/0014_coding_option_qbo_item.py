"""coding_options.qbo_item_id / qbo_item_name: QBO Product/Service per cost code

Revision ID: 0014_coding_option_qbo_item
Revises: 0013_invoice_email_auth
Create Date: 2026-10-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0014_coding_option_qbo_item"
down_revision: Union[str, None] = "0013_invoice_email_auth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "coding_options",
        sa.Column("qbo_item_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "coding_options",
        sa.Column("qbo_item_name", sa.String(length=256), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("coding_options", "qbo_item_name")
    op.drop_column("coding_options", "qbo_item_id")
