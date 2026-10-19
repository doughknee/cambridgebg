# Invoice Portal — complete feature reference

A salesperson's reference for every feature the portal has today. Everything
here is derived from the code in this repository as of October 19, 2026
(frontend v0.2.5, after REL-692 and REL-705). Nothing is aspirational: if it
is not in this document, it is not in the product.

Where the code or UI uses a term, the term is kept so a prospect's question
can be traced back to the screen it refers to. The companion sales page lives
at `/marketing` on the portal (`frontend/src/routes/marketing.tsx`) and is
built from this document. A verbatim copy is bundled into the frontend at
 so the page can offer it for
download; keep the two in sync (copy this file over that one).

---

## 1. What the product is

A web application that turns vendor invoices that arrive by email (or are
uploaded by hand) into approved, coded Bills in QuickBooks Online, with the
original PDF attached and the company's AP coding stamped onto it.

In one sentence: **vendor emails in, coded QuickBooks bills out, with a human
approval and a full audit trail in between.**

Who uses it, in the language of the code:

| Role    | What they do |
|---------|--------------|
| owner   | Everything an admin does, plus role changes and removing admins. Cannot be removed. One per deployment. |
| admin   | Reviews and approves any invoice, posts to QuickBooks, handles Triage, manages the team, trusted senders, coding options, QuickBooks and notification settings. |
| member  | Reviews, codes and approves invoices that are assigned to them. Cannot post, assign, trust senders, or change settings. |

Typical mapping: owner = controller or company principal; admin = AP
lead/accounting; member = project managers.

### Technical shape (for the "how is it built" question)

- Backend: Python, FastAPI (async), SQLAlchemy 2, PostgreSQL 16, Alembic migrations.
- Frontend: React 19, Vite, Tailwind v4, TanStack Router and Query, Motion.
- Auth: self-hosted Logto (OpenID Connect). The API verifies every request's bearer token against Logto's signing keys, issuer and audience.
- Extraction: Anthropic Claude (`claude-sonnet-4-5` by default) with vision; OpenAI `gpt-4o` as an optional fallback.
- Files: Cloudflare R2 (S3-compatible). PDFs are never served from a public URL; the backend issues 15-minute signed links or proxies the bytes itself.
- Email: Resend (inbound webhook and outbound transactional mail). A Postmark inbound endpoint still exists from an earlier cutover.
- Hosting: Docker Compose on Coolify (four containers: postgres, logto, backend, frontend). No Redis, no Celery, no queue service; background work runs inside the API process.
- Money is stored as integer cents everywhere; floats are only used at the display edge and in the QuickBooks payload.

---

## 2. Invoice lifecycle and statuses

Every document is an `Invoice` row with one of eight statuses.

| Status (UI label) | Meaning | How it gets there | What can happen next |
|---|---|---|---|
| `received` (Received) | Stored, waiting for extraction. | Email webhook or manual upload. | `extracting` automatically. |
| `extracting` (Extracting, pulsing dot) | The AI is reading the PDF right now. | Background task starts. | `ready_for_review`, `needs_triage`, or `extraction_failed`. |
| `extraction_failed` (Extraction failed) | Both AI providers failed, or the PDF could not be rendered. The error message is stored on the row. | Any exception in the pipeline. | Re-extract, or a reviewer fills the fields by hand and approves ("fix-and-approve"). |
| `needs_triage` (Triage) | Something about the document or its sender needs a human decision before it is treated as a real invoice. Always carries a `triage_reason`. | Pre-flight checks in the webhook, or the routing decision after extraction. | Promote, Trust sender + promote, Reject, Report. |
| `ready_for_review` (Needs review) | A real invoice, from a recognised sender, read with high confidence. | Routing after extraction, or promotion from Triage. | Assign, claim, edit, approve, reject, report. |
| `approved` (Approved; sub-badge "Pending post" or "Post failed") | A reviewer confirmed vendor and total. Not yet in QuickBooks. | Approve. | Post to QBO, unapprove (back to review), edit then re-approve, reject. |
| `posted_to_qbo` (Posted; sub-badge shows the QBO bill number) | A Bill exists in QuickBooks with the PDF attached. | Successful post. | Nothing. Posted invoices cannot be edited, rejected, re-extracted or re-posted. |
| `rejected` (Rejected) | Closed without posting. The reason is appended to the notes. | Reject or Report. | Nothing. Kept for the audit trail. |

Transitions enforced by the API:

- Approve requires a vendor (name or linked vendor) and a non-zero total; negative subtotal, tax or total is refused.
- Post requires status `approved` **and** all four AP coding fields (job number, cost code, coding date, approver). The error message tells the user exactly which are missing.
- Approve and post can be done as one action ("Approve & Post to QBO") by an admin.
- Unapprove reverts `approved` to `ready_for_review` and clears the reviewer and any post error.

---

## 3. Getting invoices in

### 3.1 Email intake (Resend inbound)

Vendors email a dedicated inbound address. Resend calls the portal's webhook
(`POST /api/webhooks/resend`). What happens, in order:

1. **Signature check.** The webhook is verified with Resend's Svix-style HMAC-SHA256 signature. Requests older than 5 minutes are rejected (replay protection). Only `email.received` events are processed; other event types are acknowledged and ignored.
2. **Deduplication.** Each inbound email has a provider message id stored on the invoice row with a unique constraint. The same email delivered twice creates nothing the second time. An email with several PDFs creates one invoice per PDF, each with a suffixed id so they stay unique.
3. **Fetch content.** The webhook only carries metadata, so the backend calls Resend's API for the text/HTML body, the parsed headers, and each attachment's bytes. Only PDF attachments are kept; other attachment types are logged and skipped.
4. **Email authentication summary.** The `Authentication-Results` header is reduced to a string like `spf=pass dkim=pass dmarc=fail` and stored on the invoice. See section 6.
5. **Per-PDF pre-flight.**
   - Page count is read (best effort).
   - **Encrypted PDF check.** If the PDF needs a password (the empty password is tried first, since some signing tools "encrypt" with none), the row goes straight to Triage with reason `encrypted_pdf` and extraction is skipped. The notes say to ask the vendor for an unencrypted copy or upload a decrypted one.
   - The PDF is uploaded to R2 under `invoices/YYYY/MM/<uuid>.pdf`. If the upload fails, a rejected stub is recorded with the error so nothing silently disappears.
   - Otherwise the row is created as `received`, an `email_received` audit entry is written (with sender, auth summary, subject, filename), and extraction is queued.
6. **Body-only emails.** If there is no PDF but the email has a body, the body is rendered into a one-page letter-format PDF (HTML is stripped to text; the header shows From, Subject and Received; the footer reads "Rendered from email body — no original attachment"). That PDF rides the normal pipeline but is pre-flagged `body_rendered`, so even a perfect extraction lands in Triage for a human to confirm.
7. **Nothing usable.** No PDF and no body creates a `rejected` stub and an `email_rejected_no_pdf` audit entry, so the sender and subject are still visible in Activity.

The legacy Postmark endpoint (`POST /api/webhooks/postmark`, Basic Auth
password) runs the identical flow and is kept so the inbound provider can be
swapped back without a deploy.

### 3.2 Manual upload

- "Upload PDF" button on the queue, or drag one or more PDFs anywhere onto the queue page (a dashed amber overlay appears).
- PDF only; empty files are rejected. Several files can be queued at once; each shows a progress card while it uploads and extracts.
- Uploads record the uploading user as the sender and are **never** subject to the sender gate (an upload is by definition from a trusted person).

### 3.3 Storage and viewing

- All PDFs live in a private R2 bucket. The review page streams the bytes through the backend (so the in-browser viewer works without cross-origin setup) and "Open in new tab" uses a 15-minute signed link.
- The original PDF in R2 is never modified. The stamped version (section 10) is generated at post time and only sent to QuickBooks.

---

## 4. AI extraction

### 4.1 What the model receives

- Pages are rendered to PNG at 110 DPI and downscaled to 2048 px wide.
- Up to **8 pages** go to the model. Longer documents are sampled as the **first 6 pages plus the last 2**, because totals live at the end. The model is told which page numbers were omitted and instructed to trust the printed totals block rather than summing the visible lines.
- At most **2 extractions run concurrently** per backend process to keep memory bounded on a small container.

### 4.2 Providers, retries, fallback

- Primary: Anthropic Claude, model configurable (`EXTRACTION_MODEL`, default `claude-sonnet-4-5`), output cap 16,384 tokens.
- Fallback: OpenAI (`OPENAI_EXTRACTION_MODEL`, default `gpt-4o`) if an OpenAI key is configured.
- Each provider gets up to **3 attempts with exponential backoff** (1s, 2s) on transient errors (rate limits, timeouts, connection errors, 5xx). Non-transient errors fail immediately. If every provider is exhausted the invoice becomes `extraction_failed` with the combined error message.
- The response must be JSON. A repair pass fixes the one recurring model habit of writing arithmetic (`"tax_cents": 7.33 + 54.12`) by evaluating it and converting dollars to cents.

### 4.3 What is extracted

| Field | Notes |
|---|---|
| vendor_name, vendor_address | "Do not hallucinate vendor names from letterheads that aren't clearly the biller." |
| invoice_number, po_number | |
| invoice_date, due_date | ISO dates; null if only month/year is printed. |
| subtotal_cents, tax_cents, total_cents, currency | Integer cents, taken from the printed totals block only. |
| line_items[] | description (concise, ~80 chars, hard cap 160), quantity, unit_price_cents, amount_cents. |
| notes | Free text, including the explanation when the document is not an invoice. |
| confidence | `high`, `medium` or `low`. Anything below `high` goes to Triage. |
| document_type | `invoice`, `statement`, `quote`, `order_ack`, `receipt`, `supporting_doc`, `other`, `unknown`. Only `invoice` can reach the review queue directly. |
| job_number, cost_code, coding_date, approver | The AP coding markup, if a human already wrote or stamped it on the PDF (typed box, stamp or handwriting). The prompt describes the expected formats and tells the model to return null rather than guess. |

### 4.4 After extraction

- **Vendor matching.** The extracted vendor name is fuzzy-matched (token set ratio) against the synced QuickBooks vendors and linked only when the score is **85 or higher**; otherwise the vendor field is left for the reviewer. The scorer was chosen specifically to stop unrelated names from being matched.
- The `extraction_completed` audit entry records vendor, number, total, line count, coding fields, confidence, document type and the routing result.
- **Re-extract** is available on any non-posted invoice and resets it to `received` before re-running the pipeline.

---

## 5. Routing and the Triage bucket

After a successful extraction the row is routed by this precedence (the first
rule that matches wins):

| # | Condition | Result | Reason badge in UI |
|---|---|---|---|
| 1 | `document_type` is not `invoice` | Triage | "Not an invoice" (plus a grey document-type badge: Statement, Quote, Order ack, Receipt, Supporting doc, Other) |
| 2 | Email auth summary contains a hard `fail` | Triage | "Failed sender verification" (red) |
| 3 | Sender is not on the trusted list (email-sourced only) | Triage | "Unknown sender" (amber) |
| 4 | `confidence` is not `high` | Triage | "Low confidence" (amber) |
| 5 | Pre-flagged `body_rendered` | Triage | "From email body" (blue) |
| 6 | Otherwise | Needs review | — |

Two reasons are set before extraction ever runs: `encrypted_pdf` (red badge
"Encrypted PDF", extraction skipped) and `body_rendered` (as above). Rules 2
and 3 are **hard gates** as of REL-692: a convincing fake invoice is exactly
the case where "trust the content" fails, so an unrecognised or unverified
sender always waits for a human, no matter how confident the AI was.

The six triage reasons, what the review page tells the operator, and the
actions available:

| Reason | Guidance text shown on the review page | Actions |
|---|---|---|
| non_invoice | "Claude classified this as something other than an invoice (statement, quote, order acknowledgement, receipt, or supporting document). If it's actually a real invoice, click Promote." | Promote, Reject, Report |
| unknown_sender | "We don't recognise this sender yet. Check the From address against the vendor you expect. Click Trust sender + promote if it's a real vendor, or Report if it looks like a scam." | Trust sender + promote, Promote, Reject, Report |
| auth_failed | "This email failed the standard sender checks (SPF/DKIM/DMARC), which is a sign the From address may be forged. Confirm with the vendor by phone before promoting." | Promote, Reject, Report |
| body_rendered | "There was no PDF attachment — we rendered the email body as a fallback. Verify the totals and line items extracted correctly before promoting." | Promote, Reject, Report |
| encrypted_pdf | "This PDF is password-protected so extraction was skipped. Ask the vendor to resend an unencrypted copy, or upload a decrypted version manually." | Promote, Reject, Report |
| low_confidence | "Claude wasn't confident about its extraction. Review the fields, fix anything wrong, then promote when it looks right." | Promote, Reject, Report |

Who can do what in Triage (API rules):

- **Promote** (`needs_triage` to `ready_for_review`, clears the reason, keeps the document type): any signed-in user.
- **Trust sender + promote**: admin or owner only, because it trusts every future email from that sender.
- **Reject** and **Report**: admin/owner, or the assignee (triage rows are normally unassigned, so in practice admins). The queue only shows Reject to admins.

The queue's "Triage" view lists these rows with the reason badge instead of a
status badge and inline Promote / Reject buttons. The empty state reads
"Ambiguous documents — statements, quotes, encrypted PDFs — land here for a
quick decision."

---

## 6. Trusted senders and email authentication

### 6.1 The trusted-sender list

Settings → "Trusted email domains" (admin+). Entries come from three sources:

| Source | How it gets there | Can an admin delete it? |
|---|---|---|
| `qbo_sync` | Every "Sync vendors" run extracts the domain of each active QuickBooks vendor's email address. Entries whose vendor no longer has that email are removed on the next sync. | No. The API returns 409: "QBO-synced domains can't be manually removed. Remove or edit the vendor in QBO and re-run sync." |
| `manual` | An admin types a domain or address in Settings, optionally with a note. | Yes |
| `promoted_from_triage` | An admin clicked "Trust sender + promote" on a triage row. The note records which invoice it came from. | Yes |

Matching rules:

- Domains are stored in registrable form, so `billing.silvercote.com` and `ap@silvercote.com` both match one entry `silvercote.com`. Common two-part suffixes (`co.uk`, `com.au`, …) are handled.
- **Public mail providers are trusted by full address, never by domain.** `bob@gmail.com` can be trusted; `gmail.com` cannot (the API refuses with an explanatory message). The list covers Gmail, Yahoo, Outlook/Hotmail/Live, AOL, iCloud, Proton and the major US ISP domains.
- Every trust and untrust action is audited (`sender_trusted`, `sender_untrusted`) with the domain and source.

### 6.2 SPF / DKIM / DMARC

- The inbound provider's `Authentication-Results` header is summarised and stored on every email-sourced invoice.
- Only a hard `fail` counts as failed. `softfail`, `none`, `neutral`, or a missing header are treated as unknown, never as failure.
- The verdict is shown on the navy identity bar of **every** email-sourced invoice, not only triage rows: "From <address> · trusted sender" (green), "unknown sender" (amber) or "failed sender verification" (red, with the raw summary as a tooltip).

### 6.3 Report as suspicious

Available on the triage banner and in the review footer (admin/owner, or the
assignee). It:

1. Rejects the invoice and appends "[Reported as suspicious] by <email>" to its notes.
2. Posts a red embed to a Discord channel webhook with: vendor, a link back to the invoice, sender, subject, total, email auth summary, triage reason and reporter.
3. Writes an `invoice_reported` audit entry recording whether the Discord post was sent.

The post is best-effort: if the webhook URL is unset or Discord is down the
rejection still stands. For Cambridge the channel is RelentNet's
`#cambridgebg-reports`; for another company it is whatever webhook URL is
configured (`DISCORD_REPORT_WEBHOOK_URL`), or nothing.

---

## 7. The queue and the review page

### 7.1 Queue views

The invoice list is a work inbox with five filter pills, each with a live
count, mirrored as a jump-nav in the sidebar and persisted in the URL
(`?view=`) so a view can be bookmarked.

| View | Contents | Default for |
|---|---|---|
| Needs review | Unassigned invoices in `ready_for_review`, `extraction_failed`, `received` or `extracting`. | Admins and owners |
| Assigned to me | The same statuses, assigned to the signed-in user. | Members |
| Ready to post | `approved` invoices waiting for an admin to post. | |
| Triage | `needs_triage`. | |
| All | Everything, newest first. | |

Search matches vendor name, invoice number, PO number, sender email and job
number. The API also accepts a dedicated job filter ("all invoices for job
25-11-04"). Lists are paginated (25 per page by default, up to 100).

Each row shows: assignee initials (or an email/upload/triage icon), vendor,
status badge (plus "Pending post" / "Post failed" / the QBO bill number where
relevant), invoice number, job number, sender, relative time, total, and
**one next action**:

- Admin: Review (active rows), Post (approved rows), Promote/Reject (triage).
- Member: "Claim & review" on their own unclaimed rows, "Review" once claimed, "Open" elsewhere.
- Any backend refusal (for example "Cambridge AP coding incomplete — fill in job number…") is shown in red under the row instead of failing silently.

### 7.2 Assignment and claiming

- Only admins/owners can assign, reassign or unassign. The picker lists the team and has an "Email the assignee" checkbox (on by default).
- Reassigning resets the claim. The assignee "claims" the invoice ("Claim to review") to signal they have taken ownership; `claimed_at` is shown as initials in the row.
- Admins act on any invoice directly without assigning it to themselves. Members can only act on invoices assigned to them **and** must claim first. The API enforces the same rule, not just the UI.

### 7.3 The review page

Layout: a navy identity bar (vendor, invoice number, total, status, assignee,
sender line) that updates live as you type; the PDF on one side (page
navigation, open in new tab); the form on the other.

Form sections, in order:

1. **Cambridge coding**: Job no., Cost code, Coding date, Approver. Job number, cost code and approver are comboboxes fed by the admin-managed options (free text still allowed). Cost codes show their full description next to the code.
2. **Assignment**: Vendor (searchable, from synced QuickBooks vendors) and Project (synced Customers or Classes).
3. Invoice #, PO #, Invoice date, Due date.
4. Subtotal, Tax, Total (client-side validation before save).
5. Line items (editable, removable).

Other controls on the page:

- **Stamp preview**: a live rendering of the AP stamp that will be burned into the PDF. In edit mode it can be dragged and resized directly on page 1 of the PDF; "Reset stamp" returns it to the default. The position persists per invoice.
- **Save draft** (persists edits without changing status), **Approve**, **Approve & Post to QBO** (admins), **Assign / Reassign…**, **Unapprove**, **Reject** (reason required; `⌘+Shift+R`), **Report as suspicious**, **Re-extract**, **Retry post to QBO** (after a failed post), **Notify** (admins email chosen teammates about this invoice with an optional note).
- After posting, the page becomes a read-only summary with an "open in QuickBooks" deep link to the bill (sandbox or production host chosen automatically). An approved invoice can be edited again; saving unapproves it first and the footer offers "Save and re-approve".
- The footer is sticky and on phones collapses into a single full-width split button whose menu carries Save draft, Reject, Report and Cancel.

---

## 8. Identity, roles and the team

### 8.1 Sign-in

- Self-hosted Logto provides the sign-in screen (themed to the company) and issues the tokens. Sign-up is email-first so invite links work without a pre-set password.
- Backend checks on every request: signature (JWKS, cached 1 hour), issuer, audience, expiry. If Logto itself is unreachable the API answers 503 rather than 401, so a blip never signs anyone out.
- Passkeys/MFA factors registered in Logto are listed under Settings → Account, where a user can remove one themselves (fixes "I registered a passkey on my PC and now my phone is locked out").

### 8.2 Roles

Stored as Logto roles and read per request.

| Action | owner | admin | member |
|---|---|---|---|
| Review / approve / reject any invoice | yes | yes | only assigned + claimed |
| Post to QuickBooks | yes | yes | no |
| Assign / reassign / unassign | yes | yes | no |
| Promote from Triage | yes | yes | yes |
| Trust sender | yes | yes | no |
| Invite, resend invite, remove members | yes | yes | no |
| Remove an admin | yes | no | no |
| Change roles | yes | member↔admin only | no |
| Grant owner (hands off ownership; the previous owner becomes admin) | yes | no | no |
| Settings: QuickBooks, coding options, trusted senders, digest schedule | yes | yes | read-only notice |
| Own account: name, password, passkeys, notification preferences | yes | yes | yes |

Nobody can change their own role or remove themselves. On backend start the
longest-tenured user without a role is promoted to owner; a script
(`promote_owner.py`) exists for the manual case.

### 8.3 Invites and access requests

- **Invite member** (Team page, admin+): creates the Logto user as a member with `needs_password`, mints a one-time token (valid 7 days), and emails a branded magic link via Resend with the inviter as reply-to. If email is not configured the admin gets the link to share by hand. Inviting an existing address resends a fresh link.
- First sign-in through the link lands in the app with a **password setup modal** (minimum 8 characters, at least three of lowercase/uppercase/number/symbol).
- **Request access**: the public landing page has a form (email, name, message) that posts to a public endpoint, throttled to 5 submissions per hour per IP and per email, idempotent per pending email. Admins see pending requests at the top of the Team page with a count badge in the sidebar and can Approve (which runs the invite flow) or Dismiss. Source IP and user agent are stored for abuse review.

---

## 9. AP coding options

Settings → "AP coding options" (admin+). Three managed lists: job numbers,
cost codes, approvers. Each option has a value (what gets stamped), an
optional label (description shown in the dropdown), and an active toggle
(hidden from dropdowns but kept for history). Values are unique per field.
Reviewers can still type a custom value.

Cost-code options additionally carry a **QuickBooks Product/Service mapping**
(section 11.3).

---

## 10. The AP coding stamp

When an invoice is posted, and only if all four coding fields are present,
the backend composes a stamp onto **page 1** of a copy of the PDF and attaches
that copy to the QuickBooks bill. The R2 original is untouched.

- Appearance: white box with a navy outline, amber header band reading "CAMBRIDGE" / "AP CODING", four rows: JOB #, COST CD, DATE (mm/dd/yy), APPROVED, values in a monospace face. Mirrors the HTML preview on the review page.
- Default placement: top-right, 220 pt wide, 24 pt margin. Per-invoice position and size are stored as fractions of the page and clamped so a bad value can never push the stamp off the page or make it invisible.
- Failure handling: if stamping fails for any reason (unreadable PDF, encrypted file, zero pages) the original is attached instead, posting continues, and an `invoice_stamp_failed` audit entry is written. Stamping never blocks a post.

---

## 11. QuickBooks Online

### 11.1 Connection

- Settings → "Connect to QuickBooks Online" starts Intuit's OAuth 2.0 flow (accounting scope). The `state` value is recorded in the audit log and must match within 30 minutes on callback, which blocks CSRF-style connection hijacks.
- One QuickBooks company per deployment. Sandbox or production is an environment setting; the UI shows which.
- Access tokens are refreshed automatically 5 minutes before expiry, and a 401 triggers one forced refresh and retry. Refresh tokens last about 100 days and roll forward on use; Settings and the invoice page warn 3 days before one would lapse ("needs reconnect").
- Disconnect clears the tokens but keeps the configuration (default expense account, project source), so reconnecting does not silently break posting.
- Status card shows realm id, token expiries, last vendor/project sync, and warns when no default expense account is set.

### 11.2 Sync

| Button | What it does |
|---|---|
| Sync vendors | Upserts every QuickBooks Vendor (name, email, active). Vendors missing from QuickBooks are deactivated locally. Then refreshes the `qbo_sync` trusted-sender entries from vendor emails. |
| Sync projects | Pulls either Customers (default; sub-customers become projects) or Classes, per the "Project source" setting. Missing ones are deactivated. |
| Sync items | Matches each cost-code option to a QuickBooks Product/Service by name (section 11.3). |

A read-only "Vendors & projects" page lists what was synced and when.

### 11.3 Cost code to Product/Service mapping (REL-705)

- "Sync items" normalises both sides (case, letter O versus zero, punctuation) so `01-520.0`, `01-520.O` and `01-520 "O"` all compare equal, then takes an exact match or a unique prefix match (QuickBooks item names usually carry a description after the code). Ambiguous matches are logged and left unmapped rather than guessed.
- Manual picks in Settings are never overwritten by a sync; a mapped item that later disappears from QuickBooks is flagged in the log.
- Unmapped codes are allowed; the bill line simply falls back to the default expense account.

### 11.4 Bill posting

Posting is **admin/owner only** and runs as a background task, idempotently:

1. The vendor must be linked to a QuickBooks vendor (otherwise: "run Sync Vendors first").
2. Bill payload: VendorRef; TxnDate (invoice date); DueDate; DocNumber (invoice number, 21-char cap); PrivateNote ("PO: …", the notes, and the portal invoice id); CurrencyRef for non-USD.
3. Lines: one per extracted line item that has an amount, plus a separate "Sales Tax" line when tax is present, so the bill total equals the invoice total. If there are no usable line items, a single line for the full total.
4. Each line is an **item-based expense line** (ItemRef, Qty 1, UnitPrice) when the invoice's cost code is mapped to a Product/Service, otherwise an **account-based expense line** on the default expense account. Every line also gets the project: CustomerRef (marked not billable) for Customer-sourced projects, ClassRef for Class-sourced ones.
5. If a bill id already exists from an earlier attempt, bill creation is skipped and only the attachment step runs.
6. The (stamped) PDF is uploaded as an Attachable linked to the bill.
7. Status becomes `posted_to_qbo`; `qbo_bill_created` and `qbo_bill_attached` audit entries are written.

On any failure the invoice stays `approved`, the error text is stored and
shown ("Post failed" badge, full message on the page), a `qbo_post_failed`
audit entry is written, and "Retry post to QBO" is offered. Retrying is safe.

---

## 12. Notifications

All email goes out through Resend with branded templates. If Resend is not
configured every send is skipped gracefully and logged.

| Email | Trigger | Controls |
|---|---|---|
| "Invoice assigned to you: <vendor>" | An admin assigns an invoice to someone else, with "Email the assignee" ticked. Not sent for self-assignment or when the assignee did not change. | Recipient can opt out (Settings → My notifications). Outcome audited (`assignment_notified` / `assignment_notify_failed`). |
| "Your invoice review queue (N pending)" daily digest | An in-process scheduler ticks every minute and fires once per day after the configured time. Each person with `ready_for_review` invoices assigned to them gets their list with amounts and links. | Admin: on/off, send time (24h), timezone (defaults 07:30 America/Chicago), "Send now" for testing. Per-user opt-out. Audited (`daily_digest_sent` with recipient counts). |
| "Please review: <vendor>" / "A note from the … Portal" | Admin clicks Notify on an invoice, picks teammates, optionally adds a note. | Audited (`manual_notification_sent`). |
| Invite / fresh invite link | Section 8.3. | |

---

## 13. Activity (audit log)

Every meaningful action writes an `audit_logs` row with actor, timestamp,
optional invoice, action, before/after JSON diffs and a message. Field edits
store only the changed keys, before and after.

The Activity page renders these as sentences ("Brandon approved Acme Supply
#INV-1042 · 2 hours ago"), grouped by day, filterable by person and by action
(grouped into Invoice, Review, QuickBooks, Processing, Notifications,
Settings). A "Detailed" toggle shows the raw before/after panes. Pages of up
to 200 entries; the API also filters by invoice id.

Actions recorded (37 distinct):

- Invoice: `invoice_uploaded`, `email_received`, `email_rejected_no_pdf`, `invoice_edited`, `triage_routed`, `triage_promoted`
- Reading: `extraction_started`, `extraction_completed`, `extraction_failed`, `invoice_reextract_requested`, `invoice_stamp_failed`
- Review: `invoice_assigned`, `invoice_unassigned`, `invoice_claimed`, `invoice_approved`, `invoice_approved_and_post_requested`, `invoice_unapproved`, `invoice_rejected`, `invoice_reported`
- QuickBooks: `invoice_post_requested`, `qbo_bill_created`, `qbo_bill_attached`, `qbo_post_failed`, `qbo_oauth_initiated`, `qbo_connected`, `qbo_disconnected`, `qbo_sync_vendors`, `qbo_sync_projects`, `qbo_sync_items`
- Settings: `qbo_default_expense_account_changed`, `qbo_project_source_changed`, `sender_trusted`, `sender_untrusted`
- Notifications: `assignment_notified`, `assignment_notify_failed`, `daily_digest_sent`, `manual_notification_sent`

(Plus two legacy aliases, `approve` and `unapprove`, kept for old rows.)

---

## 14. Administration and operations

- **Health**: `GET /api/health` reports API and database status; used by the host's health check.
- **Operational reset**: a script (`clear_operational_data.py`) purges invoices, audit log, access requests, trusted senders, the QuickBooks token and synced vendors/projects while keeping user accounts and coding options. Intended for a clean cut-over from sandbox to production data.
- **Owner promotion**: `promote_owner.py <email>`, idempotent.
- **Logto bootstrap and theme**: scripts create the app registrations and apply the brand CSS to the hosted sign-in page.
- **Backups**: database volume snapshots via the host; R2 object versioning recommended.
- **Secrets**: all in environment variables; none in the frontend bundle (AI calls are server-side; PDF links are signed).
- **Error surfacing**: structured JSON 500s; extraction and posting failures are stored on the invoice and in the audit log with the full provider error.

---

## 15. Mobile

The portal is a responsive web app, not a native app. Below tablet width:

- A bottom tab bar (Invoices, Team, More) replaces the sidebar; More opens a sheet with What's new, Activity, Settings, account and sign out.
- A compact app bar carries the page title and the page's one action (for example Upload).
- Modals become bottom sheets; filters become horizontally scrolling chips; all buttons meet a 44 px tap target; the review footer becomes a single full-width split button.
- Expired sessions return the user to sign-in instead of showing connection errors.

---

## 16. What's new

An in-app release history (`/whats-new`) written in plain English, one entry
per version, with a "New" badge in the sidebar until the user opens it. The
current version is printed at the bottom of the sidebar. Versions to date:
0.2.0 (work-inbox queue, activity log, notifications), 0.2.1 (the page
itself), 0.2.2 (notification controls, QuickBooks posting fixes, vendor
matching), 0.2.3 (clearer errors, session expiry), 0.2.4 (account
self-service), 0.2.5 (cost-code descriptions, admin-only posting). The two
October changes (sender gate and item-based bills) have not yet been added
to this list.

Public legal pages exist at `/privacy` and `/eula`.

---

## 17. Configurable per company versus Cambridge-specific

### Set per deployment through environment variables

| Area | Settings |
|---|---|
| URLs | app and API base URLs, CORS origin |
| Identity | Logto endpoints, app id, API resource, M2M credentials |
| AI | Anthropic key and model; optional OpenAI key and model |
| Files | R2 account, keys, bucket, endpoint |
| Inbound email | Resend webhook secret (and/or Postmark secret) |
| Outbound email | Resend API key, From name/address |
| QuickBooks | client id/secret, sandbox/production, redirect URI, optional default expense account |
| Reporting | Discord webhook URL (empty disables the post, Report still rejects) |
| Landing page | contact email for Request access |

### Set per company through the UI (admin)

- QuickBooks connection, project source (Customer or Class), default expense account
- Coding option lists (job numbers, cost codes, approvers) and cost-code to Product/Service mapping
- Trusted sender list (manual entries and notes)
- Daily digest on/off, time, timezone
- Team membership and roles; each user's own notification preferences

### Currently Cambridge-specific (would need code or asset changes for another company)

- The product name "Cambridge Invoice Portal" and the "Cambridge Building Group" kicker in the UI, email templates, rendered email-body PDFs and the Logto sign-in theme
- The stamp header text "CAMBRIDGE / AP CODING" and the form section title "Cambridge coding"
- The extraction prompt names Cambridge Building Group and describes Cambridge's coding formats (job numbers like `25-11-04`, cost codes like `01-520 "O"`, initials as approver). Another company with different code formats would need the prompt adjusted.
- The posting error wording "Cambridge AP coding incomplete"
- Brand colours (navy `#0b1b25`, amber `#c8923c`, stone `#ede5d8`) and fonts (DM Serif Display, Plus Jakarta Sans)
- Legal pages (Cambridge's address and support email)
- Default timezone America/Chicago and default bucket name
- The Report destination is RelentNet's Discord; for another customer it would be their own channel or disabled
- One company, one QuickBooks file, one trusted-sender list per deployment. Multi-company means one deployment per company.

---

## 18. Numbers that come straight from the code

These are the only figures a salesperson should quote. There are no
customer-volume or time-saved metrics in the repository.

| Figure | Where it comes from |
|---|---|
| 8 statuses, 6 triage reasons, 8 document types, 3 roles | Enums in the models |
| 37 distinct audit actions (plus 2 legacy aliases) | Audit calls in the backend |
| Up to 8 pages per document sent to the AI (first 6 + last 2 when longer) | Extraction constants |
| 2 AI providers, 3 attempts each with backoff | Extraction fallback |
| 85/100 minimum score to auto-link a vendor | Vendor matcher |
| 2 concurrent extractions per backend process | Extraction semaphore |
| 15-minute signed PDF links | Storage |
| 5-minute webhook replay window | Resend signature check |
| 30-minute OAuth state window; 5-minute token refresh buffer; ~100-day refresh token; 3-day reconnect warning | QuickBooks client and router |
| 7-day invite links | Invitations |
| 5 access requests per hour per IP and per email | Access-request rate limit |
| 23 public mail-provider domains trusted by address instead of domain | Trusted-sender service |
| Digest scheduler checks every 60 seconds | Notifications |
| 44 px minimum tap targets on phones | Button component |
| Dozens of invoices per day is the designed volume ("no Redis/Celery") | README design decisions |

---

## 19. Honest limits (answer these before the prospect asks)

- One company per deployment; one QuickBooks file per company.
- Vendors must already exist in QuickBooks; the portal does not create vendors.
- No PO matching, no payment runs, no approval limits or multi-step approval chains. One approval, then an admin posts.
- Extraction is strong but not infallible: that is why everything passes a human, and why low confidence and non-invoices go to Triage.
- Documents longer than 8 pages are sampled; line items on omitted pages are not extracted (totals still are).
- The sender gate relies on QuickBooks vendor emails and the manual list; a vendor without an email in QuickBooks will land in Triage until trusted once.
- The daily digest scheduler and the access-request rate limiter run inside the single API process (fine at this scale; a multi-instance deployment would need a shared store).
- No CSV export of the activity log or invoices today.
- Mobile is responsive web, not a native app.
- The What's new page has not yet been updated for the October 2026 changes.
