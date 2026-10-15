# Email pipeline edge-case hardening — Triage bucket design

Date: 2026-04-30
Status: approved, ready to implement

## Problem

Five edge cases in the inbound email pipeline that today either lose
information or pollute the main review queue:

1. **Statements / quotes / order acks** (e.g. the Silvercote "Order
   Acknowledgement") are misclassified as invoices and clutter the main
   queue.
2. **Body-only invoices** — small vendors that email totals in plaintext
   with no attachment — currently land as a "no PDF" rejected stub.
3. **Multiple PDFs in one email** all become separate invoices with no
   indication of their relationship.
4. **Unknown senders** can drop arbitrary PDFs into the queue (no gating).
5. **Encrypted / password-protected PDFs** loop through extraction, fail,
   and sit in `EXTRACTION_FAILED` with no clear next step.

## Goal

Keep the main queue tightly invoice-only. Route everything ambiguous to
a dedicated **Triage** bucket the AP team can drain on its own schedule.
Don't lose information; don't make AP think.

## Routing rules

```
inbound email arrives
  ├─ encrypted PDF? ────────→ NEEDS_TRIAGE, reason=encrypted_pdf, skip extraction
  ├─ no PDF + has body? ────→ render body to PDF, mark body_rendered, run extraction
  ├─ extraction failed? ────→ EXTRACTION_FAILED (existing status, retry-able, NOT triage)
  └─ extraction succeeded
       ├─ document_type≠invoice ───────────────────→ NEEDS_TRIAGE (non_invoice)
       ├─ SPF/DKIM/DMARC hard fail ────────────────→ NEEDS_TRIAGE (auth_failed)
       ├─ sender not in trusted allowlist ─────────→ NEEDS_TRIAGE (unknown_sender)
       ├─ document_type=invoice + confidence<high ─→ NEEDS_TRIAGE (low_confidence)
       ├─ body_rendered pre-flight ────────────────→ NEEDS_TRIAGE (body_rendered)
       └─ otherwise ───────────────────────────────→ READY_FOR_REVIEW
```

Reasons are checked in priority order:
`encrypted_pdf > non_invoice > auth_failed > unknown_sender > low_confidence > body_rendered`.

**Revised 2026-10-15 (REL-692):** `unknown_sender` and `auth_failed` are
hard gates. The original design treated the sender as a tiebreaker and
trusted the document content; a convincing spoofed invoice is exactly
the case that fails on, so a sender we don't recognise (or one whose
email failed SPF/DKIM/DMARC) always waits in Triage. Nothing is dropped:
an admin confirms the sender with one click and it moves to the queue.
Senders on public mail providers (gmail.com etc.) are trusted by full
address, never by domain.

## Data model

New `InvoiceStatus` enum value: `NEEDS_TRIAGE`.

Two new nullable columns on `invoices`:

```python
class DocumentType(str, Enum):
    INVOICE = "invoice"
    STATEMENT = "statement"
    QUOTE = "quote"
    ORDER_ACK = "order_ack"
    RECEIPT = "receipt"
    SUPPORTING_DOC = "supporting_doc"   # cover letter, W-9, etc.
    OTHER = "other"
    UNKNOWN = "unknown"

class TriageReason(str, Enum):
    NON_INVOICE = "non_invoice"
    UNKNOWN_SENDER = "unknown_sender"
    BODY_RENDERED = "body_rendered"
    ENCRYPTED_PDF = "encrypted_pdf"
    LOW_CONFIDENCE = "low_confidence"

invoices.document_type  SAEnum(DocumentType, native_enum=False, nullable=True)
invoices.triage_reason  SAEnum(TriageReason,  native_enum=False, nullable=True)
```

New table `trusted_sender_domains` for the manual+auto allowlist:

```python
class TrustedSenderDomain(Base):
    id: UUID
    domain: str (unique, lowercase, registrable form e.g. "silvercote.com")
    source: 'qbo_sync' | 'manual' | 'promoted_from_triage'
    qbo_vendor_id: UUID | None       # backref when source=qbo_sync
    added_by_id: str | None          # Logto user id, when source=manual
    added_at: datetime
    notes: str | None
```

Migration `0009_email_triage_design.py`:
- Adds `document_type` and `triage_reason` columns to `invoices`
- Recreates the `status` CHECK constraint to include `needs_triage`
- Adds `trusted_sender_domains` table with the columns above
- Existing rows: `document_type=null`, `triage_reason=null`,
  `status` unchanged. Treat null `document_type` as "pre-feature row,
  don't try to retroactively triage."

## Backend changes

### Extraction prompt + schema
Extraction prompt asks Claude to also classify `document_type`. Update
`ExtractedFields`, persist on the invoice. Existing rows that get
re-extracted get `document_type` populated.

### Webhook routing (`app/routers/webhooks.py`)
Pre-extraction checks:
- **Encrypted PDF**: `pypdf.PdfReader(io.BytesIO(content)).is_encrypted`
  (with fallback to `decrypt('')`). If encrypted with no empty-string
  password → status `NEEDS_TRIAGE`, `triage_reason=encrypted_pdf`,
  skip the extraction background task.
- **No attachment + non-empty body**: render body to PDF via
  `app/services/email_render.py::render_body_to_pdf` (reportlab,
  consistent with stamp service). Stored in R2 under the same key
  pattern. Set `triage_reason=body_rendered` if extraction confidence
  isn't high after running.
- **Multiple attachments**: existing per-PDF flow, no change. UI
  surfaces siblings via shared `email_message_id` base.

Post-extraction routing in `app/services/extraction.py`:
- After persisting fields, decide status:
    - `document_type == invoice` and `confidence == high` → `READY_FOR_REVIEW`
    - `document_type == invoice` and `confidence < high` → `NEEDS_TRIAGE`,
      `triage_reason=low_confidence`
    - `document_type != invoice` → `NEEDS_TRIAGE`, `triage_reason=non_invoice`

### Body rendering (`app/services/email_render.py`)
- Pure-python reportlab. Takes `(sender, subject, received_at, body)` and
  renders a styled letter-format PDF. Strips HTML tags via stdlib's
  `html.parser` (no BeautifulSoup dep) when body looks like HTML.
- Adds an explicit footer "Rendered from email body — no original
  attachment" so AP knows what they're looking at.
- Returns PDF bytes.

### Trusted domains (`app/services/trusted_domains.py`, `app/routers/trusted_domains.py`)
- `extract_registrable_domain(email_or_url)` — last-2-parts heuristic
  that handles common eTLDs (`.co.uk`, `.com.au`); good enough for
  vendor email matching, no `tldextract` dep.
- `is_trusted(session, sender_email)` — case-insensitive lookup.
- QBO vendor sync hook: after `sync_vendors`, scan vendor emails,
  upsert domain into `trusted_sender_domains` with source=qbo_sync.
  Vendors without an email don't contribute. Removed/deactivated
  vendors don't auto-remove the domain (manual cleanup).
- Endpoints:
  - `GET    /api/trusted-domains` (admin+)
  - `POST   /api/trusted-domains` (admin+, body: `{domain}`)
  - `DELETE /api/trusted-domains/{id}` (admin+; refuses if source=qbo_sync)

### Triage actions on invoice router
- `POST /api/invoices/{id}/promote` — moves NEEDS_TRIAGE → READY_FOR_REVIEW.
  Audited as `triage_promoted`. Refuses if status isn't NEEDS_TRIAGE.
- `POST /api/invoices/{id}/trust-sender` — extracts the sender's
  registrable domain, adds to `trusted_sender_domains` with
  `source=promoted_from_triage`, then calls promote. Single click in UI.
- Existing reject endpoint already works for triage rejects; no new endpoint.

## UI changes

### Queue page (`InvoiceQueue.tsx`)
- New filter chip "Triage" with pending-count badge in amber. Sits
  between Approved and Archived. Hidden when count is zero (don't
  draw attention to a clean inbox).
- When active, renders a dedicated `TriageRow` component instead of
  the standard `InvoiceRow`:
  - Reason badge (Statement / Encrypted / Body-only / Low confidence /
    Unknown sender), each with its own color and icon.
  - Inline action menu: **Promote** / **Reject** / **Trust sender +
    promote** (only if `triage_reason=unknown_sender` or sender domain
    is not yet in allowlist).
  - Fall-through link to full review screen for inspection.

### Review screen
- Status banner when invoice is in NEEDS_TRIAGE — explains the reason
  and suggests the right action. Has the same Promote/Reject buttons
  as the queue row.
- "Rendered from email body" footnote when `triage_reason=body_rendered`,
  visible even after promotion.

### Settings page
- New section "Trusted email domains" (admin+ only):
  - Read-only list of QBO-synced domains (badge: "from QBO")
  - Editable list of manual + promoted-from-triage domains
  - Add input + remove button per row
  - Tooltip: "Sync vendors to refresh QBO-derived entries"

## Telemetry / audit

All five new actions in `audit_logs`, no schema change:
- `triage_routed` (system) — when a fresh invoice lands in NEEDS_TRIAGE,
  message describes the reason
- `triage_promoted` (actor) — before/after status
- `triage_rejected` (actor) — reason text in message
- `sender_trusted` (actor) — domain added (with source)
- `sender_untrusted` (actor) — domain removed

## Out of scope (deliberately)

- **Per-PDF intent classification within multi-PDF emails** (would need
  a Claude pre-classification call per attachment; not worth the API
  spend at this volume).
- **Auto-link supporting docs to parent invoice** — siblings shown via
  shared `email_message_id`, AP rejects supporting docs manually.
- **Auto-reply / OOO filtering** by mail headers (low frequency at
  Cambridge's volume; can add later if it becomes painful).
- **Duplicate detection by content hash** — relies on different sender
  flow than triage; separate spec if needed.
- **Spam / phishing protection** beyond sender allowlist — Postmark
  handles transport-layer abuse.
- **Migrating EXTRACTION_FAILED to triage** — keeping retry semantics
  separate.

## Implementation order

1. Backend foundation: enum values + migration + prompt + extraction
   captures `document_type`. Existing flow unchanged at this point.
2. Backend routing: webhook + extraction set status correctly.
   Encrypted PDF + body-to-PDF rendering land here.
3. Backend trusted domains: model + endpoints + QBO sync hook +
   `is_trusted()` integration with routing.
4. Backend triage actions: promote / trust-sender endpoints + audit.
5. Frontend types + triage filter chip + badges.
6. Frontend triage actions (promote, reject, trust sender).
7. Frontend trusted-domains Settings section.

Each step is its own commit. Steps 1–4 are independently shippable
(visible UI changes don't appear until step 5+, but the backend is
already routing correctly, so AP can use the API directly if needed).
