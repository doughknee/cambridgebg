"""REL-705: bills post as item-based lines keyed by the invoice's cost code.

Covers the payload builder (mapped vs unmapped), the cost-code name matcher
used by the item sync, and the migration chain staying linear.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test.db")

from app.models.coding_option import CodingOption
from app.services import qbo_posting, qbo_sync

BACKEND = Path(__file__).resolve().parents[1]


def _invoice(**overrides):
    base = dict(
        id="inv-1",
        invoice_number="A-100",
        invoice_date=None,
        due_date=None,
        po_number=None,
        notes=None,
        currency="USD",
        cost_code="01-520.0",
        line_items=[{"description": "Toilet rental", "amount_cents": 10000}],
        tax_cents=625,
        total_cents=10625,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


VENDOR = SimpleNamespace(qbo_id="v1")
PROJECT = SimpleNamespace(qbo_id="c9", qbo_type="Customer")


def test_mapped_cost_code_posts_item_lines() -> None:
    payload = qbo_posting._build_bill_payload(_invoice(), VENDOR, PROJECT, "50000", "item-7")

    assert [ln["DetailType"] for ln in payload["Line"]] == [
        "ItemBasedExpenseLineDetail",
        "ItemBasedExpenseLineDetail",
    ]
    main, tax = payload["Line"]
    assert main["Amount"] == 100.0
    assert main["ItemBasedExpenseLineDetail"] == {
        "ItemRef": {"value": "item-7"},
        "Qty": 1,
        "UnitPrice": 100.0,
        "CustomerRef": {"value": "c9"},
        "BillableStatus": "NotBillable",
    }
    # The tax line follows the same item / project allocation.
    assert tax["Description"] == "Sales Tax"
    assert tax["ItemBasedExpenseLineDetail"]["ItemRef"] == {"value": "item-7"}
    assert tax["ItemBasedExpenseLineDetail"]["UnitPrice"] == 6.25
    assert "AccountBasedExpenseLineDetail" not in main


def test_unmapped_cost_code_keeps_account_lines() -> None:
    payload = qbo_posting._build_bill_payload(_invoice(), VENDOR, PROJECT, "50000", None)

    for ln in payload["Line"]:
        assert ln["DetailType"] == "AccountBasedExpenseLineDetail"
        assert ln["AccountBasedExpenseLineDetail"]["AccountRef"] == {"value": "50000"}
        assert ln["AccountBasedExpenseLineDetail"]["CustomerRef"] == {"value": "c9"}
        assert "ItemRef" not in ln["AccountBasedExpenseLineDetail"]


def test_single_total_line_with_class_project() -> None:
    inv = _invoice(line_items=[], tax_cents=0)
    payload = qbo_posting._build_bill_payload(
        inv, VENDOR, SimpleNamespace(qbo_id="k2", qbo_type="Class"), "50000", "item-7"
    )

    (line,) = payload["Line"]
    detail = line["ItemBasedExpenseLineDetail"]
    assert line["Amount"] == detail["UnitPrice"] == 106.25
    assert detail["ClassRef"] == {"value": "k2"}
    assert "CustomerRef" not in detail


ITEMS = [
    {"id": "1", "name": "01-520.O Temp Toilet", "fully_qualified_name": "01 General Conditions:01-520.O Temp Toilet"},
    {"id": "2", "name": "01-530 Dumpster", "fully_qualified_name": "01 General Conditions:01-530 Dumpster"},
    {"id": "3", "name": "01-531 Dumpster Pulls", "fully_qualified_name": "01 General Conditions:01-531 Dumpster Pulls"},
    {"id": "4", "name": "02-100", "fully_qualified_name": "02 Sitework:02-100"},
]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("01-520.0", "1"),  # zero in the portal, letter O in QBO
        ('01-520 "O"', "1"),  # stamp form with quotes
        ("01-520.o temp toilet", "1"),  # exact, case-insensitive
        ("01-530", "2"),  # unique prefix
        ("02-100", "4"),  # exact match on a bare code
        ("01-53", None),  # ambiguous prefix: 01-530 and 01-531
        ("01", None),  # too short to mean anything
        ("99-999", None),  # no such item
    ],
)
def test_match_item(value: str, expected: str | None) -> None:
    hit = qbo_sync.match_item(value, ITEMS)
    assert (hit["id"] if hit else None) == expected


@pytest.mark.asyncio
async def test_sync_items_maps_unmapped_and_keeps_manual(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/items.db")
    async with engine.begin() as conn:
        await conn.run_sync(CodingOption.__table__.create)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with factory() as session:
        session.add_all(
            [
                CodingOption(field="cost_code", value="01-520.0"),
                CodingOption(field="cost_code", value="01-530", qbo_item_id="4", qbo_item_name="old"),
                CodingOption(field="cost_code", value="99-999"),
                CodingOption(field="job_number", value="01-530"),
            ]
        )
        await session.commit()

    async def fake_query(_session, sql: str):
        assert sql == "SELECT * FROM Item"
        return [
            {"Id": i["id"], "Name": i["name"], "FullyQualifiedName": i["fully_qualified_name"]}
            for i in ITEMS
        ] + [{"Id": "9", "Name": "99-999 Retired", "Active": False}]

    monkeypatch.setattr(qbo_sync.qbo_client, "qbo_query", fake_query)

    async with factory() as session:
        counts = await qbo_sync.sync_items(session)
        await session.commit()
    assert counts == {"items": 4, "mapped": 2, "unmapped": 1}

    async with factory() as session:
        rows = {
            (r.field, r.value): r
            for r in (await session.execute(CodingOption.__table__.select())).mappings()
        }
    assert rows[("cost_code", "01-520.0")]["qbo_item_id"] == "1"
    assert rows[("cost_code", "01-520.0")]["qbo_item_name"] == "01 General Conditions:01-520.O Temp Toilet"
    # Manual mapping kept, display name refreshed from QBO.
    assert rows[("cost_code", "01-530")]["qbo_item_id"] == "4"
    assert rows[("cost_code", "01-530")]["qbo_item_name"] == "02 Sitework:02-100"
    assert rows[("cost_code", "99-999")]["qbo_item_id"] is None
    assert rows[("job_number", "01-530")]["qbo_item_id"] is None


def test_migration_chain_has_single_head() -> None:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert heads == ["0014_coding_option_qbo_item"]
