/**
 * Content for the public /marketing sales kit. Every claim here is traced to
 * the code; the long-form version is docs/marketing/feature-reference.md.
 * Keep this file in plain English — it is read aloud by a salesperson.
 */

export interface Feature {
  title: string;
  what: string;
  why: string;
  group: "Intake" | "Reading" | "Review" | "Accounting" | "Team" | "Trust";
}

export const FEATURES: Feature[] = [
  {
    group: "Intake",
    title: "Vendors just email the invoice",
    what: "Each company gets an inbound address. A PDF attached to an email becomes an invoice in the queue within seconds. Several PDFs in one email become several invoices. The same email delivered twice is ignored.",
    why: "No portal for vendors to learn, no forwarding rules, no one re-saving attachments to a shared drive.",
  },
  {
    group: "Intake",
    title: "Emails with no attachment still count",
    what: "If a vendor writes the amount in the body of the email instead of attaching a PDF, the portal renders the email into a PDF, reads it, and flags it for a quick human check.",
    why: "Small subcontractors do this constantly. Nothing is lost and nothing is silently rejected.",
  },
  {
    group: "Intake",
    title: "Drag-and-drop upload",
    what: "Drop one or many PDFs anywhere on the queue, or use the Upload button. Each file shows its own progress card while it uploads and is read.",
    why: "Paper and hand-delivered invoices take the same path as emailed ones.",
  },
  {
    group: "Reading",
    title: "AI reads the invoice, in cents",
    what: "Vendor, invoice number, PO, dates, subtotal, tax, total, currency and every line item are extracted by Claude from an image of the pages. Money is stored as whole cents, never floating point. If the primary model is unavailable, a second provider takes over automatically.",
    why: "Nobody re-keys an invoice. The totals come from the printed totals block, so freight and rounding are not lost.",
  },
  {
    group: "Reading",
    title: "It knows an invoice from a statement",
    what: "Every document is classified as an invoice, statement, quote, order acknowledgement, receipt, supporting document or other. Only invoices read with high confidence go straight to the review queue.",
    why: "Statements and quotes stop clogging the inbox and stop getting paid twice.",
  },
  {
    group: "Reading",
    title: "It reads your AP stamp too",
    what: "If AP already wrote or stamped the job number, cost code, date and approver on the paper, the model looks for that cluster and fills the coding fields. If it cannot read them confidently it leaves them blank rather than guessing.",
    why: "Existing paper habits carry over. Wrong codes never get invented.",
  },
  {
    group: "Reading",
    title: "Vendors match themselves to QuickBooks",
    what: "The extracted vendor name is matched against the QuickBooks vendor list and linked only when the match score is 85 out of 100 or better. Otherwise the reviewer picks from a searchable list.",
    why: "No wrong-vendor bills, and no typing vendor names.",
  },
  {
    group: "Trust",
    title: "Unknown senders wait at the door",
    what: "An email from an address the company has not trusted lands in Triage, no matter how convincing the PDF is. Trusted senders come from QuickBooks vendor emails automatically, plus a manual list. One click trusts a sender for good.",
    why: "This is the control that stops invoice fraud: a lookalike invoice from a stranger never reaches the approval queue unnoticed.",
  },
  {
    group: "Trust",
    title: "Forged sender addresses are flagged",
    what: "Each inbound email's SPF, DKIM and DMARC results are recorded. A hard failure sends the invoice to Triage and shows a red 'failed sender verification' line on the invoice.",
    why: "Spoofed vendor emails are the most common invoice scam. The reviewer sees the warning before they see the amount.",
  },
  {
    group: "Trust",
    title: "Report a suspicious invoice in one click",
    what: "Report rejects the invoice and posts the sender, subject, amount, authentication result and reporter to a chat channel so the right people are alerted immediately. The rejection stands even if the alert cannot be delivered.",
    why: "A fraud attempt becomes a shared, time-stamped record instead of one person's memory.",
  },
  {
    group: "Review",
    title: "A queue that says what needs you",
    what: "Five views with live counts: Needs review, Assigned to me, Ready to post, Triage and All. Every row carries its next action: Review, Claim, Post, Promote or Reject. Views are bookmarkable.",
    why: "A controller opens one screen and knows what is waiting and on whom.",
  },
  {
    group: "Review",
    title: "Assign, claim, approve",
    what: "Admins assign invoices to project managers, optionally with an email. The PM claims it, codes it and approves it. Admins can act on anything directly. The rules are enforced by the server, not just hidden in the interface.",
    why: "Project managers own their invoices; accounting keeps control of what reaches QuickBooks.",
  },
  {
    group: "Review",
    title: "Review page built for coding",
    what: "PDF on one side, fields on the other. Job number, cost code and approver are dropdowns fed by the company's own lists, with free text allowed. Vendor and project come from QuickBooks. The header with vendor, total and status updates as you type.",
    why: "Coding takes seconds and uses the real codes, so the bill lands on the right job and the right cost code.",
  },
  {
    group: "Accounting",
    title: "The AP stamp is burned into the PDF",
    what: "At posting time the four coding values are drawn onto page 1 of the PDF in a branded stamp box. The stamp can be dragged and resized on the page per invoice. The original file is kept untouched.",
    why: "The copy in QuickBooks looks exactly like the paper copy AP used to stamp, so auditors find what they expect.",
  },
  {
    group: "Accounting",
    title: "Posts a real QuickBooks Bill, coded by cost code",
    what: "Each extracted line becomes a bill line against the QuickBooks Product/Service mapped to the invoice's cost code, allocated to the project (Customer or Class), with a separate sales-tax line so the bill equals the invoice. Codes without a mapping fall back to a default expense account. The stamped PDF is attached.",
    why: "Job-cost reports in QuickBooks are right without anyone re-keying lines.",
  },
  {
    group: "Accounting",
    title: "Posting is safe to retry",
    what: "If QuickBooks is down or rejects something, the invoice stays approved, the exact error is shown, and Retry does not create a duplicate bill. Posting is limited to admins and owners; PMs approve, accounting posts.",
    why: "No duplicate bills, no mystery failures, and one team holds the keys to the ledger.",
  },
  {
    group: "Accounting",
    title: "QuickBooks stays in sync",
    what: "Vendors, projects (sub-customers or classes) and Products/Services sync on demand. Removed vendors are deactivated. The connection refreshes its own tokens and warns three days before it would lapse.",
    why: "The dropdowns always reflect the live chart of jobs and vendors.",
  },
  {
    group: "Team",
    title: "Owner, admin, member",
    what: "Three roles with clear limits: members review their own assignments; admins run the queue, settings and the team; one owner can change roles and remove admins. Nobody can promote themselves.",
    why: "Separation of duties that an auditor can read off a table.",
  },
  {
    group: "Team",
    title: "Magic-link invites and access requests",
    what: "Admins invite by email; the link is valid seven days and the newcomer sets a password on first sign-in. Outsiders can request access from the landing page; requests queue for an admin to approve or dismiss.",
    why: "Onboarding a new PM is an email, not a ticket.",
  },
  {
    group: "Team",
    title: "Email digests on everyone's terms",
    what: "An email the moment an invoice is assigned to you, a daily digest of what is still waiting (time and timezone set by an admin), and manual nudges from admins. Each person can switch their own emails off.",
    why: "Invoices stop aging in someone's queue unnoticed.",
  },
  {
    group: "Team",
    title: "An activity log written in English",
    what: "Every upload, read, edit, assignment, approval, rejection, post and setting change is recorded with who, when and what changed. The Activity page reads like sentences, filters by person or action, and has a detailed before/after view.",
    why: "Month-end questions and audit requests are answered from one screen.",
  },
  {
    group: "Team",
    title: "Works on a phone",
    what: "Bottom tab bar, bottom sheets, large tap targets and a single full-width action button on the review page. Expired sessions go back to sign-in cleanly.",
    why: "PMs approve from the job site, not from their desk on Friday.",
  },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: Faq[] = [
  {
    q: "How accurate is the AI? What happens when it is wrong?",
    a: "Every invoice is reviewed by a person before it is approved, and the model reports its own confidence. Anything it is not highly confident about, and anything that is not an invoice, goes to Triage instead of the review queue. Reviewers can edit any field, and every edit is recorded with the before and after values.",
  },
  {
    q: "Can it be fooled by a fake invoice?",
    a: "A PDF alone cannot get into the review queue. The sender has to be on the trusted list (built from your QuickBooks vendor emails plus anything you add), and the email has to pass SPF, DKIM and DMARC. Fail either test and it waits in Triage with a reason badge. Gmail-style senders are trusted one address at a time, never by domain. If something still looks wrong, Report rejects it and alerts a chat channel.",
  },
  {
    q: "Does it replace our approval process or fit into it?",
    a: "It fits a two-step process: a project manager (member) codes and approves, an admin posts to QuickBooks from the Ready to post view. Admins can also approve and post in one action. There are no spending limits or multi-level chains today.",
  },
  {
    q: "What does it put in QuickBooks exactly?",
    a: "A Bill on the matched vendor with the invoice number, invoice date and due date, one line per extracted line item against the Product/Service mapped to the cost code (or the default expense account), each line allocated to the project, a separate sales-tax line, a private note carrying the PO and the portal's invoice id, and the stamped PDF as an attachment.",
  },
  {
    q: "What if posting fails halfway?",
    a: "The invoice stays approved with the exact QuickBooks error on screen. Retry picks up where it left off: if the bill was already created, it only re-attaches the PDF. No duplicates.",
  },
  {
    q: "Do our vendors have to do anything differently?",
    a: "No. They email a PDF to one address. If they put the amount in the email body instead, that still works and gets a human check.",
  },
  {
    q: "What about password-protected or very long PDFs?",
    a: "Password-protected PDFs skip extraction and land in Triage with a clear note to ask the vendor for an open copy. Up to eight pages are read; longer documents are sampled as the first six plus the last two so the totals page is never missed.",
  },
  {
    q: "Where do the files live? Who can see them?",
    a: "PDFs are stored in private object storage. The app serves them only to signed-in users through short-lived links. The AI call happens on the server; no keys are in the browser.",
  },
  {
    q: "Can we use our own job numbers and cost codes?",
    a: "Yes. Admins maintain the lists of job numbers, cost codes and approvers in Settings, each with an optional description. Cost codes map to QuickBooks Products/Services automatically by name, and you can override any mapping.",
  },
  {
    q: "Does it track projects as Customers or Classes?",
    a: "Either. A setting picks the source; sub-customers or classes sync from QuickBooks and become the Project dropdown.",
  },
  {
    q: "How do people get access?",
    a: "An admin invites them by email. The link works for seven days and they choose a password on first sign-in. A Request access form on the landing page queues outsiders for an admin to approve.",
  },
  {
    q: "Is there an audit trail?",
    a: "Thirty-seven distinct events are recorded, from 'received by email' to 'attached the PDF in QuickBooks', with the actor, the time and the changed fields. The Activity page is readable by anyone on the team and filterable.",
  },
  {
    q: "What is not in the product today?",
    a: "Purchase-order matching, payment runs, approval limits, multi-level approvals, vendor creation in QuickBooks, CSV export, and a native mobile app. One company and one QuickBooks file per deployment.",
  },
  {
    q: "How is it hosted?",
    a: "Four containers (database, sign-in service, API, web) on a Docker host, behind HTTPS. QuickBooks, email and storage are external services connected with keys that live only on the server.",
  },
];

export interface ConfigItem {
  item: string;
  detail: string;
}

export const CONFIG_ENV: ConfigItem[] = [
  { item: "Inbound and outbound email", detail: "Resend account, inbound webhook secret, From name and address." },
  { item: "AI providers", detail: "Anthropic key and model; optional OpenAI key and model as fallback." },
  { item: "File storage", detail: "Cloudflare R2 account, keys and bucket (any S3-compatible store)." },
  { item: "QuickBooks app", detail: "Client id and secret, sandbox or production, optional default expense account." },
  { item: "Sign-in service", detail: "Logto endpoints and application ids." },
  { item: "Fraud alerts", detail: "Chat webhook URL for Report as suspicious; leave empty to disable the alert." },
  { item: "Addresses", detail: "Portal URL, API URL, contact email for the Request access button." },
];

export const CONFIG_UI: ConfigItem[] = [
  { item: "QuickBooks connection", detail: "Connect, disconnect, choose Customers or Classes as projects, pick the default expense account." },
  { item: "Coding lists", detail: "Job numbers, cost codes and approvers, with descriptions and active flags; cost code to Product/Service mapping." },
  { item: "Trusted senders", detail: "Manual domains and addresses with notes, alongside the automatic QuickBooks list." },
  { item: "Daily digest", detail: "On or off, send time, timezone, send now." },
  { item: "Team", detail: "Invite, roles, removal, access-request approval." },
  { item: "Personal", detail: "Display name, password, passkeys, own email preferences." },
];

export const CONFIG_CAMBRIDGE: ConfigItem[] = [
  { item: "Name and brand", detail: "'Cambridge Invoice Portal' in the app, emails and sign-in screen; navy, amber and stone colours; the two typefaces." },
  { item: "Stamp text", detail: "The stamp header reads CAMBRIDGE / AP CODING and the form section is titled Cambridge coding." },
  { item: "Coding formats in the AI prompt", detail: "The prompt describes Cambridge's job-number and cost-code patterns so the model can read stamps. Another company's formats would be described the same way." },
  { item: "Legal pages", detail: "Privacy policy and EULA carry Cambridge's address." },
  { item: "Alert destination", detail: "Reports go to RelentNet's channel for Cambridge; another company would use its own." },
  { item: "Defaults", detail: "Central time for the digest, the storage bucket name, one company per deployment." },
];

export interface Figure {
  value: string;
  label: string;
  source: string;
}

export const FIGURES: Figure[] = [
  { value: "8", label: "pages read per invoice, first 6 plus last 2 on longer files", source: "extraction service" },
  { value: "2", label: "AI providers, 3 attempts each before an invoice is marked failed", source: "extraction fallback" },
  { value: "85", label: "out of 100: minimum score to auto-link a vendor", source: "vendor matcher" },
  { value: "6", label: "triage reasons, each with its own guidance and actions", source: "invoice model" },
  { value: "37", label: "distinct events in the activity log", source: "audit calls" },
  { value: "3", label: "roles, every permission enforced by the API, not only the interface", source: "users router" },
  { value: "15 min", label: "lifetime of a signed PDF link", source: "storage service" },
  { value: "7 days", label: "validity of an invite link", source: "invitations" },
  { value: "23", label: "public mail providers trusted by address, never by domain", source: "trusted senders" },
  { value: "5 min", label: "replay window on inbound webhooks", source: "Resend signature check" },
];

export interface DemoStep {
  title: string;
  click: string;
  say: string;
}

export const DEMO_SCRIPT: DemoStep[] = [
  {
    title: "Start on the queue",
    click: "Sign in as an admin. Land on Invoices with the Needs review view selected. Point at the five pills and their counts.",
    say: "This is the whole AP inbox. Each pill is a question: what needs a reviewer, what is mine, what is approved and waiting for accounting, what needs a human decision, and everything.",
  },
  {
    title: "Send a real invoice by email",
    click: "From your phone, forward a vendor PDF to the inbound address. Wait on the queue; the row appears as Received, then Extracting with a pulsing dot, then Needs review.",
    say: "Nothing was typed. The sender was recognised from the QuickBooks vendor list, the email passed authentication, and the model read it with high confidence, so it went straight to review.",
  },
  {
    title: "Open the review page",
    click: "Click Review. Show the navy header: vendor, number, total, status, and the sender line reading 'trusted sender'. Scroll the PDF.",
    say: "Everything on the left came off the PDF: dates, totals in cents, every line item. The vendor was matched to QuickBooks automatically.",
  },
  {
    title: "Code it",
    click: "In Cambridge coding, pick a job number and a cost code from the dropdowns (show the description next to the code), set the date, pick the approver. Watch the stamp preview fill in. Drag the stamp to a clear corner of page 1.",
    say: "These lists are yours; admins maintain them in Settings. The stamp is what gets burned onto the PDF in QuickBooks, exactly where you put it.",
  },
  {
    title: "Hand it to a PM, or approve it yourself",
    click: "Open Assign, pick a teammate, leave Email the assignee ticked, assign. Then (as the admin) use Approve & Post to QBO.",
    say: "A PM would get an email, claim it, approve it, and it would wait in Ready to post for accounting. As an admin I can do both steps at once.",
  },
  {
    title: "Show the bill in QuickBooks",
    click: "Wait for the Posted badge with the bill number. Click the QuickBooks link on the invoice. In QuickBooks show the lines keyed to Products/Services, the customer or class on each line, the sales-tax line, and the attached PDF with the stamp.",
    say: "One bill, coded by cost code, allocated to the job, with the stamped original attached. This is the part that used to be re-keyed by hand.",
  },
  {
    title: "Now the fraud story",
    click: "Switch to the Triage view. Open a row badged Unknown sender (send one from a personal address beforehand). Show the banner text and the sender line.",
    say: "This PDF looks like an invoice and was read fine, but the sender is a stranger, so it never reached the queue. One click trusts the sender for good; Report rejects it and alerts the team.",
  },
  {
    title: "Settings in two minutes",
    click: "Open Settings. Walk the sidebar jump-nav: QuickBooks (sync buttons, default account), AP coding (the three lists, cost-code mapping), Trusted senders (QBO entries versus manual), Notifications (digest time).",
    say: "Everything a company would change about the workflow lives here, and all of it is role-gated.",
  },
  {
    title: "Finish on Activity",
    click: "Open Activity. Filter to the invoice you just posted. Flip on Detailed for the edit entry.",
    say: "Every step we just took is here as a sentence with a time and a name. This is what you hand an auditor.",
  },
];

export const TALKING_POINTS: string[] = [
  "Vendor emails in, coded QuickBooks bills out, with a human approval and a full audit trail in between.",
  "No vendor onboarding: vendors email a PDF to one address. Body-only emails are rendered and read too.",
  "Claude reads vendor, numbers, dates, totals and every line item in cents; a second AI provider takes over automatically if the first is unavailable.",
  "Statements, quotes, receipts and order acknowledgements are classified and kept out of the review queue.",
  "Fraud gate: unknown senders and emails that fail SPF/DKIM/DMARC always wait in Triage. Trusted senders come from your QuickBooks vendor list automatically.",
  "Report as suspicious rejects the invoice and alerts a chat channel with sender, subject, amount and authentication result.",
  "Roles: members review what is assigned to them; admins run the queue and post; one owner controls roles. Enforced by the server.",
  "Your job numbers, cost codes and approvers as dropdowns, and the AP stamp burned onto page 1 of the PDF in QuickBooks.",
  "Bills post as item-based lines keyed by cost code, allocated to the project, with a separate tax line and the stamped PDF attached. Retry never duplicates a bill.",
  "Assignment emails, a daily digest at a time you choose, and an activity log in plain English with before/after values.",
  "Responsive on phones; sign-in by magic-link invite; passwords and passkeys self-service.",
  "Per company: QuickBooks connection, coding lists, trusted senders, digest schedule, team. Branding and the stamp text are currently Cambridge-specific.",
];

export function talkingPointsText(): string {
  return ["Invoice Portal: talking points", "", ...TALKING_POINTS.map((p) => `- ${p}`)].join("\n");
}
