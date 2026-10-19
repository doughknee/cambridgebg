/**
 * /marketing — the white-label sales kit.
 *
 * Public (outside `_authed`) on purpose: it is shared with prospects and
 * shown on a projector without a sign-in, and it reads nothing from the API.
 * Every "screenshot" is a mock built from the app's own components (Badge,
 * StatusBadge, TriageReasonBadge, FilterChips, StampPreview, the audit-action
 * map) with illustrative data, so it stays faithful as the app evolves and
 * never leaks real invoices. Copy and figures come from
 * `lib/marketingContent.ts` and `docs/marketing/feature-reference.md`.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowUpTrayIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  DocumentArrowDownIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  PaperAirplaneIcon,
} from "@heroicons/react/24/outline";
import { Badge } from "@/components/ui/Badge";
import { FilterChips } from "@/components/ui/FilterChips";
import {
  DocumentTypeBadge,
  getStatusMeta,
  PostStateBadge,
  StatusBadge,
  TriageReasonBadge,
} from "@/components/invoices/StatusBadge";
import { StampPreview } from "@/components/invoices/StampPreview";
import { describeAction, TONE_CIRCLE } from "@/lib/auditActions";
import { cn } from "@/lib/cn";
import {
  CONFIG_CAMBRIDGE,
  CONFIG_ENV,
  CONFIG_UI,
  DEMO_SCRIPT,
  FAQ,
  FEATURES,
  FIGURES,
  TALKING_POINTS,
  talkingPointsText,
  type ConfigItem,
  type Feature,
} from "@/lib/marketingContent";
import featureReference from "@/content/feature-reference.md?raw";

export const Route = createFileRoute("/marketing")({
  component: MarketingPage,
});

const SECTIONS = [
  { id: "lifecycle", label: "How it works" },
  { id: "features", label: "Features" },
  { id: "security", label: "Fraud & control" },
  { id: "numbers", label: "By the numbers" },
  { id: "configure", label: "Your company" },
  { id: "faq", label: "Questions" },
  { id: "demo", label: "Demo script" },
  { id: "reference", label: "Reference" },
];

// ──────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers or a non-secure context: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({
  text,
  label,
  className,
  tone = "amber",
}: {
  text: string;
  label: string;
  className?: string;
  tone?: "amber" | "outline" | "light";
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const tones = {
    amber: "bg-amber text-navy hover:bg-amber/90",
    outline: "border-2 border-navy text-navy hover:bg-navy hover:text-stone",
    light: "border border-stone/40 text-stone hover:border-amber hover:text-amber",
  };
  return (
    <button
      type="button"
      onClick={async () => setState((await copyText(text)) ? "done" : "failed")}
      className={cn(
        "inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
        tones[tone],
        className,
      )}
    >
      {state === "done" ? (
        <CheckIcon className="h-4 w-4" aria-hidden />
      ) : (
        <ClipboardDocumentIcon className="h-4 w-4" aria-hidden />
      )}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed, select the text" : label}
    </button>
  );
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SectionHeading({
  id,
  title,
  lede,
}: {
  id: string;
  title: string;
  lede?: string;
}) {
  return (
    <div id={id} className="scroll-mt-20 mb-8 md:mb-10 max-w-3xl">
      <h2 className="font-display text-3xl md:text-4xl text-navy leading-tight">{title}</h2>
      {lede && <p className="mt-3 text-base md:text-lg text-graphite/80 leading-relaxed">{lede}</p>}
    </div>
  );
}

/** A faithful stand-in for the app's white panel. */
function Panel({
  children,
  className,
  accent = "top",
}: {
  children: ReactNode;
  className?: string;
  accent?: "top" | "left" | "none";
}) {
  return (
    <div
      className={cn(
        "bg-white shadow-sm",
        accent === "top" && "border-t-4 border-amber",
        accent === "left" && "border-l-2 border-amber",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs text-slate-500">{children}</p>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock UI — built from the real components, illustrative data only
// ──────────────────────────────────────────────────────────────────────────

type MockStatus = "ready_for_review" | "approved" | "posted_to_qbo" | "extracting" | "needs_triage";

interface MockRow {
  vendor: string;
  status: MockStatus;
  meta: string;
  amount: string;
  initials?: string;
  billId?: string;
  action: string;
  triage?: "unknown_sender" | "non_invoice" | "encrypted_pdf";
  docType?: "statement";
}

const QUEUE_ROWS: MockRow[] = [
  { vendor: "Ridgeline Concrete", status: "ready_for_review", meta: "#RC-10422  ·  Job 25-11-04  ·  ap@ridgelineconcrete.com  ·  2h ago", amount: "$4,812.50", action: "Review" },
  { vendor: "Harbor Electric Supply", status: "extracting", meta: "billing@harborelectric.com  ·  just now", amount: "—", action: "Open →" },
  { vendor: "Summit Plumbing", status: "approved", meta: "#7731  ·  Job 26-02-09  ·  1d ago", amount: "$12,300.00", initials: "RM", action: "Post" },
  { vendor: "Metro Door & Hardware", status: "posted_to_qbo", meta: "#MD-5519  ·  Job 25-11-04  ·  3d ago", amount: "$986.21", billId: "1042", action: "Open →" },
];

const TRIAGE_ROWS: MockRow[] = [
  { vendor: "Ridgeline Concrete", status: "needs_triage", triage: "unknown_sender", meta: "#RC-10431  ·  j.carter.billing@gmail.com  ·  40m ago", amount: "$2,140.00", action: "Promote" },
  { vendor: "Harbor Electric Supply", status: "needs_triage", triage: "non_invoice", docType: "statement", meta: "billing@harborelectric.com  ·  5h ago", amount: "", action: "Promote" },
  { vendor: "Unknown vendor", status: "needs_triage", triage: "encrypted_pdf", meta: "invoices@acmeglass.com  ·  1d ago", amount: "", action: "Promote" },
];

function RowAction({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 min-h-[32px] text-xs font-bold uppercase tracking-wider border border-navy/40 text-navy whitespace-nowrap">
      {children}
    </span>
  );
}

function MockQueueRow({ row, animate, index }: { row: MockRow; animate: boolean; index: number }) {
  const left = row.initials ? (
    <span className="inline-flex items-center justify-center h-7 w-7 bg-navy text-stone text-[10px] font-semibold tracking-wider" aria-hidden>
      {row.initials}
    </span>
  ) : (
    <span className="inline-flex items-center justify-center h-7 w-7 bg-stone/70 text-slate-500">
      {row.triage ? (
        <ExclamationTriangleIcon className="h-4 w-4" aria-hidden />
      ) : (
        <EnvelopeIcon className="h-4 w-4" aria-hidden />
      )}
    </span>
  );
  const isTextAction = row.action.startsWith("Open");
  return (
    <motion.li
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.25 + index * 0.12, ease: "easeOut" }}
      className="flex items-center gap-3 px-4 py-3"
    >
      <span className="flex-shrink-0">{left}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("font-semibold truncate", row.vendor === "Unknown vendor" ? "text-slate-400 italic" : "text-navy")}>
            {row.vendor}
          </span>
          {row.triage ? (
            <span className="flex items-center gap-1.5 flex-shrink-0">
              <TriageReasonBadge reason={row.triage} />
              {row.docType && <DocumentTypeBadge type={row.docType} />}
            </span>
          ) : (
            <span className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
              <StatusBadge status={row.status} />
              <PostStateBadge invoice={{ status: row.status, qbo_bill_id: row.billId ?? null, qbo_post_error: null }} />
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500 truncate">{row.meta}</div>
      </div>
      {row.amount && (
        <div className="flex-shrink-0 text-sm font-semibold text-navy tabular-nums">{row.amount}</div>
      )}
      <div className="flex-shrink-0 flex items-center gap-3">
        {row.triage && <span className="text-xs font-semibold text-slate-500">Reject</span>}
        {isTextAction ? (
          <span className="text-xs font-semibold text-slate-500 whitespace-nowrap">{row.action}</span>
        ) : (
          <RowAction>
            {row.action === "Post" && <PaperAirplaneIcon className="h-3.5 w-3.5" aria-hidden />}
            {row.action}
          </RowAction>
        )}
      </div>
    </motion.li>
  );
}

function MockQueue({ view, animate = false }: { view: "needs_review" | "triage"; animate?: boolean }) {
  const chips = [
    { key: "needs_review", label: "Needs review", count: 4 },
    { key: "mine", label: "Assigned to me", count: 2 },
    { key: "ready_to_post", label: "Ready to post", count: 1 },
    { key: "triage", label: "Triage", count: 3 },
    { key: "all", label: "All" },
  ];
  const rows = view === "triage" ? TRIAGE_ROWS : QUEUE_ROWS;
  return (
    <Panel className="text-left" aria-hidden>
      <div className="px-4 py-3 border-b border-stone/60 flex items-center justify-between gap-3">
        <FilterChips chips={chips} active={view} onChange={() => {}} />
        <span className="hidden xl:inline-flex items-center gap-2 whitespace-nowrap bg-transparent text-navy border-2 border-navy font-semibold px-3 py-1.5 text-sm">
          <ArrowUpTrayIcon className="h-4 w-4" aria-hidden /> Upload PDF
        </span>
      </div>
      <ul className="divide-y divide-stone/60">
        {rows.map((row, i) => (
          <MockQueueRow key={row.vendor + row.status + (row.triage ?? "")} row={row} animate={animate} index={i} />
        ))}
      </ul>
    </Panel>
  );
}

function MockEmail() {
  return (
    <Panel accent="none" className="divide-y divide-stone/60">
      <div className="px-5 py-4 space-y-1 text-sm">
        <div className="flex gap-3"><span className="w-16 text-slate-500">From</span><span className="font-medium text-graphite">ap@ridgelineconcrete.com</span></div>
        <div className="flex gap-3"><span className="w-16 text-slate-500">To</span><span className="text-graphite">invoices@yourcompany.com</span></div>
        <div className="flex gap-3"><span className="w-16 text-slate-500">Subject</span><span className="text-graphite">Invoice RC-10422 — Lobby renovation pour</span></div>
        <div className="flex gap-3 items-center"><span className="w-16 text-slate-500">Attached</span>
          <span className="inline-flex items-center gap-1.5 bg-stone/70 px-2 py-0.5 text-xs font-medium text-navy">
            invoice-RC-10422.pdf <span className="text-slate-500">· 3 pages</span>
          </span>
        </div>
      </div>
      <ul className="px-5 py-4 space-y-1.5 text-xs text-graphite">
        <Check>Webhook signature verified, delivered 11 seconds ago</Check>
        <Check>Not a duplicate of any earlier email</Check>
        <Check>PDF opens without a password</Check>
        <Check mono>spf=pass dkim=pass dmarc=pass</Check>
        <Check>Sender domain ridgelineconcrete.com is on the trusted list (from QuickBooks)</Check>
      </ul>
    </Panel>
  );
}

function Check({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <CheckIcon className="h-3.5 w-3.5 mt-0.5 text-green-700 flex-shrink-0" aria-hidden />
      <span className={cn(mono && "font-mono")}>{children}</span>
    </li>
  );
}

function MockExtraction() {
  const fields: [string, string][] = [
    ["Vendor", "Ridgeline Concrete"],
    ["Invoice #", "RC-10422"],
    ["PO #", "PO-2588"],
    ["Invoice date", "2026-10-14"],
    ["Due date", "2026-11-13"],
    ["Subtotal", "$4,500.00"],
    ["Tax", "$312.50"],
    ["Total", "$4,812.50"],
  ];
  return (
    <Panel accent="none">
      <div className="px-5 py-3 border-b border-stone/60 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-navy">Read by Claude</span>
        <Badge tone="green" dot dotColor="#15803d">confidence high</Badge>
        <Badge tone="slate">type invoice</Badge>
        <span className="text-slate-500">pages 1–3 of 3</span>
      </div>
      <dl className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {fields.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-stone/50 py-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className={cn("text-graphite font-medium", /\$/.test(v) && "tabular-nums")}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="px-5 pb-4">
        <div className="text-xs text-slate-500 mb-1">Line items</div>
        <table className="w-full text-xs">
          <tbody>
            {[
              ["4000 PSI mix, 18 yd", "4,140.00"],
              ["Pump truck, 4 hr", "360.00"],
            ].map(([d, a]) => (
              <tr key={d} className="border-b border-stone/50">
                <td className="py-1 text-graphite">{d}</td>
                <td className="py-1 text-right tabular-nums text-graphite">{a}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-xs text-slate-500">
          Vendor matched to QuickBooks vendor “Ridgeline Concrete LLC” (score 94). Coding stamp not present on the PDF, fields left blank.
        </div>
      </div>
    </Panel>
  );
}

const GATES: { rule: string; outcome: ReactNode }[] = [
  { rule: "Is it an invoice, not a statement, quote, receipt or cover letter?", outcome: <TriageReasonBadge reason="non_invoice" /> },
  { rule: "Did the email pass SPF, DKIM and DMARC?", outcome: <TriageReasonBadge reason="auth_failed" /> },
  { rule: "Is the sender on the trusted list?", outcome: <TriageReasonBadge reason="unknown_sender" /> },
  { rule: "Was the model highly confident?", outcome: <TriageReasonBadge reason="low_confidence" /> },
  { rule: "Was there a real PDF, not a rendered email body?", outcome: <TriageReasonBadge reason="body_rendered" /> },
];

function MockGate() {
  return (
    <Panel accent="none">
      <div className="px-5 py-3 border-b border-stone/60 text-xs text-slate-500">
        Checked in this order after reading. Password-protected PDFs skip reading and go straight to Triage as <TriageReasonBadge reason="encrypted_pdf" />.
      </div>
      <ol className="divide-y divide-stone/60">
        {GATES.map((g, i) => (
          <li key={g.rule} className="px-5 py-3 flex items-center gap-3 text-sm">
            <span className="font-display text-lg text-amber w-5 flex-shrink-0">{i + 1}</span>
            <span className="flex-1 text-graphite">{g.rule}</span>
            <span className="hidden sm:inline text-xs text-slate-500">if not</span>
            <span className="flex-shrink-0">{g.outcome}</span>
          </li>
        ))}
        <li className="px-5 py-3 flex items-center gap-3 text-sm bg-amber/10">
          <CheckIcon className="h-5 w-5 text-green-700 w-5 flex-shrink-0" aria-hidden />
          <span className="flex-1 text-graphite font-medium">All five pass</span>
          <StatusBadge status="ready_for_review" />
        </li>
      </ol>
    </Panel>
  );
}

function MockField({ label, value, options }: { label: string; value: string; options?: boolean }) {
  return (
    <div className="w-full">
      <div className="text-xs font-medium text-slate-600 mb-1">{label}</div>
      <div className="h-10 px-3 flex items-center justify-between border border-slate-300 bg-stone/50 text-sm text-graphite">
        <span className="truncate">{value}</span>
        {options && <span className="text-slate-400 text-xs">▾</span>}
      </div>
    </div>
  );
}

function MockCoding() {
  const coding = {
    job_number: "25-11-04",
    cost_code: '03-300 "C"',
    coding_date: "2026-10-16",
    approver: "jwh",
  };
  return (
    <Panel accent="none" className="p-5">
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_14rem] gap-6 items-start">
        <div className="space-y-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-amber mb-2">Cambridge coding</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <MockField label="Job no." value="25-11-04 — Lobby renovation" options />
              <MockField label="Cost code" value='03-300 "C" — Cast-in-place concrete' options />
              <MockField label="Coding date" value="10/16/2026" />
              <MockField label="Approver" value="jwh" options />
            </div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-amber mb-2">Assignment</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <MockField label="Vendor" value="Ridgeline Concrete LLC" options />
              <MockField label="Project" value="25-11-04 Lobby renovation" options />
            </div>
          </div>
        </div>
        <div className="xl:pt-6">
          <StampPreview invoice={coding} />
          <Caption>Drag and resize it on page 1 of the PDF. This is what QuickBooks receives.</Caption>
        </div>
      </div>
      <div className="mt-5 pt-4 border-t-2 border-navy flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-600 inline-flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-700" /> All changes saved
        </span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-graphite px-3 py-2">Reject</span>
          <span className="inline-flex items-center bg-amber text-navy font-semibold px-4 py-2 text-sm">Approve</span>
          <span className="inline-flex items-center bg-amber text-navy font-semibold px-2 py-2 text-sm border-l border-navy/20">▾</span>
        </div>
      </div>
    </Panel>
  );
}

function MockBill() {
  const lines = [
    { desc: "4000 PSI mix, 18 yd", item: '03-300.C Cast-in-place concrete', proj: "25-11-04 Lobby renovation", amt: "4,140.00" },
    { desc: "Pump truck, 4 hr", item: '03-300.C Cast-in-place concrete', proj: "25-11-04 Lobby renovation", amt: "360.00" },
    { desc: "Sales Tax", item: '03-300.C Cast-in-place concrete', proj: "25-11-04 Lobby renovation", amt: "312.50" },
  ];
  return (
    <Panel accent="none">
      <div className="px-5 py-3 border-b border-stone/60 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-navy">Bill</span>
        <Badge tone="navy"><span className="font-mono">#1042</span></Badge>
        <span className="text-slate-500 text-xs">Vendor Ridgeline Concrete LLC · Doc RC-10422 · Due 2026-11-13</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500 border-b border-stone/60">
            <th className="px-5 py-2 font-medium">Description</th>
            <th className="py-2 font-medium">Product/Service</th>
            <th className="py-2 font-medium">Customer</th>
            <th className="px-5 py-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.desc} className="border-b border-stone/50 text-graphite">
              <td className="px-5 py-2">{l.desc}</td>
              <td className="py-2">{l.item}</td>
              <td className="py-2">{l.proj}</td>
              <td className="px-5 py-2 text-right tabular-nums">{l.amt}</td>
            </tr>
          ))}
          <tr className="text-navy font-semibold">
            <td className="px-5 py-2" colSpan={3}>Total, equals the invoice</td>
            <td className="px-5 py-2 text-right tabular-nums">4,812.50</td>
          </tr>
        </tbody>
      </table>
      <div className="px-5 py-3 border-t border-stone/60 text-xs text-graphite flex flex-wrap gap-x-4 gap-y-1">
        <span>Attachment: invoice-RC-10422.pdf, stamped</span>
        <span className="text-slate-500">Private note: PO: PO-2588 — Portal invoice ID: 3f9c…</span>
      </div>
    </Panel>
  );
}

const ACTIVITY_SAMPLE: { action: string; actor: string; obj: string; when: string; message?: string }[] = [
  { action: "email_received", actor: "The portal", obj: "Ridgeline Concrete #RC-10422", when: "9:02 AM" },
  { action: "extraction_completed", actor: "The portal", obj: "Ridgeline Concrete #RC-10422", when: "9:02 AM" },
  { action: "invoice_assigned", actor: "Nigel", obj: "Ridgeline Concrete #RC-10422", when: "9:10 AM", message: "rmiller@yourcompany.com" },
  { action: "invoice_claimed", actor: "Rachel", obj: "Ridgeline Concrete #RC-10422", when: "9:41 AM" },
  { action: "invoice_edited", actor: "Rachel", obj: "Ridgeline Concrete #RC-10422", when: "9:44 AM" },
  { action: "invoice_approved", actor: "Rachel", obj: "Ridgeline Concrete #RC-10422", when: "9:45 AM" },
  { action: "qbo_bill_created", actor: "The portal", obj: "Ridgeline Concrete #RC-10422", when: "10:12 AM" },
  { action: "qbo_bill_attached", actor: "The portal", obj: "Ridgeline Concrete #RC-10422", when: "10:12 AM" },
  { action: "triage_routed", actor: "The portal", obj: "Ridgeline Concrete #RC-10431", when: "10:30 AM", message: "reason=unknown_sender" },
  { action: "invoice_reported", actor: "Nigel", obj: "Ridgeline Concrete #RC-10431", when: "10:36 AM" },
];

function MockActivity() {
  return (
    <Panel accent="none">
      <div className="px-5 py-3 border-b border-stone/60 text-xs text-slate-500">Today</div>
      <ul className="divide-y divide-stone/50">
        {ACTIVITY_SAMPLE.map((e, i) => {
          const info = describeAction(e.action);
          return (
            <li key={i} className="px-5 py-2.5 flex items-start gap-3 text-sm">
              <span className={cn("inline-flex items-center justify-center h-7 w-7 flex-shrink-0 rounded-full", TONE_CIRCLE[info.tone])}>
                <info.Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex-1 min-w-0 text-graphite">
                <span className="font-semibold text-navy">{e.actor}</span> {info.phrase}{" "}
                {info.invoiceObject && <span className="font-medium">{e.obj}</span>}
                {info.suffix}
                {e.message && info.showMessage && <span className="text-slate-500"> — {e.message}</span>}
              </span>
              <span className="text-xs text-slate-400 whitespace-nowrap">{e.when}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Status pill for navy backgrounds, as the real identity header draws it. */
function DarkStatusPill({ status }: { status: "ready_for_review" | "needs_triage" }) {
  const meta = getStatusMeta(status);
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide border border-stone/30 text-stone">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.dotColor }} aria-hidden />
      {meta.label}
    </span>
  );
}

function MockIdentityBar({ verdict }: { verdict: "trusted" | "unknown" | "failed" }) {
  const v = {
    trusted: { from: "ap@ridgelineconcrete.com", text: "trusted sender", cls: "text-green-300", auth: "spf=pass dkim=pass dmarc=pass", status: "ready_for_review" as const },
    unknown: { from: "j.carter.billing@gmail.com", text: "unknown sender", cls: "text-amber", auth: "spf=pass dkim=pass dmarc=none", status: "needs_triage" as const },
    failed: { from: "ap@ridgelineconcrete.com", text: "failed sender verification", cls: "text-red-300", auth: "spf=fail dkim=fail dmarc=fail", status: "needs_triage" as const },
  }[verdict];
  return (
    <div className="bg-navy text-stone px-5 py-4 border-t-4 border-amber">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-display text-lg leading-tight">Ridgeline Concrete</span>
        <span className="font-display text-lg tabular-nums flex-shrink-0">$2,140.00</span>
      </div>
      <div className="mt-2"><DarkStatusPill status={v.status} /></div>
      <div className="mt-2 text-xs text-stone/60">
        From <span className="text-stone font-medium break-all">{v.from}</span>
      </div>
      <div className={cn("text-xs", v.cls)}>{v.text}</div>
      <div className="mt-2 font-mono text-[11px] text-stone/40">{v.auth}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────

function MarketingPage() {
  const reduced = useReducedMotion();
  useEffect(() => {
    const prev = document.title;
    document.title = "Invoice Portal — sales kit";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="min-h-screen bg-stone text-graphite">
      <TopBar />
      <Hero animate={!reduced} />
      <main className="mx-auto max-w-6xl px-5 sm:px-8">
        <Lifecycle />
        <Features />
        <Security />
        <Numbers />
        <Configure />
        <Questions />
        <Demo />
        <Reference />
      </main>
      <footer className="mt-24 border-t border-navy/10">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 py-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-slate-500">
          <span>Invoice Portal, built by RelentNet for Cambridge Building Group. Every statement on this page is taken from the product's code on October 19, 2026.</span>
          <span className="flex gap-4 flex-shrink-0 whitespace-nowrap">
            <Link to="/" className="hover:text-navy">Sign-in page</Link>
            <Link to="/privacy" className="hover:text-navy">Privacy</Link>
            <Link to="/eula" className="hover:text-navy">EULA</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-30 bg-navy text-stone border-b border-stone/10">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 h-14 flex items-center justify-between gap-4">
        <a href="#top" className="flex items-baseline gap-3 min-w-0 flex-shrink-0">
          <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber">Sales kit</span>
          <span className="font-display text-base leading-none truncate">Invoice Portal</span>
        </a>
        <nav className="hidden xl:flex items-center gap-5 text-xs text-stone/70" aria-label="Sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="hover:text-amber transition-colors whitespace-nowrap">
              {s.label}
            </a>
          ))}
        </nav>
        <CopyButton text={talkingPointsText()} label="Copy talking points" tone="light" className="px-3 py-1.5 text-xs whitespace-nowrap flex-shrink-0" />
      </div>
    </header>
  );
}

function Hero({ animate }: { animate: boolean }) {
  return (
    <section id="top" className="relative overflow-hidden bg-navy bg-grid bg-noise text-stone">
      <div className="relative z-10 mx-auto max-w-6xl px-5 sm:px-8 pt-14 pb-16 md:pt-20 md:pb-24 grid grid-cols-1 lg:grid-cols-[5fr_6fr] gap-12 lg:gap-16 items-center">
        <div className="max-w-xl">
          <h1 className="font-display text-4xl sm:text-5xl md:text-6xl leading-[1.05] tracking-tight">
            Vendor emails in. Coded QuickBooks bills out.
          </h1>
          <p className="mt-6 text-base md:text-lg text-stone/75 leading-relaxed">
            An accounts-payable portal for contractors. Invoices arrive by email, are read by AI,
            pass a fraud gate, get coded and approved by your own people, and post to QuickBooks
            Online as item-based bills with the stamped PDF attached. Every step is logged.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <a
              href="#demo"
              className="inline-flex items-center justify-center bg-amber text-navy font-semibold px-6 py-3 text-sm hover:bg-amber/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-navy"
            >
              Open the demo script
            </a>
            <a
              href="#lifecycle"
              className="inline-flex items-center justify-center border-2 border-stone/60 text-stone font-semibold px-6 py-3 text-sm hover:border-amber hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-navy"
            >
              See how it works
            </a>
          </div>
          <p className="mt-6 text-xs text-stone/50 max-w-md">
            In production at Cambridge Building Group. The screens on this page are built from the
            portal's own components with illustrative invoices.
          </p>
        </div>
        <div className="min-w-0">
          <MockQueue view="needs_review" animate={animate} />
          <p className="mt-3 text-xs text-stone/50">
            The invoice queue, as an admin sees it. Five views with live counts; each row carries its next action.
          </p>
        </div>
      </div>
    </section>
  );
}

const STAGES: { title: string; body: string; mock: ReactNode; note: string }[] = [
  {
    title: "A vendor emails the invoice",
    body: "The portal receives the email through a signed webhook, checks it is not a duplicate, pulls out each PDF, records whether the email passed SPF, DKIM and DMARC, and notes whether the sender is already trusted. Password-protected PDFs and emails with no attachment are handled, not dropped.",
    mock: <MockEmail />,
    note: "Intake receipt. Nothing here involved a person.",
  },
  {
    title: "AI reads it",
    body: "Pages are rendered as images and sent to Claude (OpenAI stands in if Claude is unavailable). It returns the vendor, numbers, dates, totals and line items as whole cents, says what kind of document it is and how confident it is, and looks for an existing AP stamp. The vendor is matched against QuickBooks.",
    mock: <MockExtraction />,
    note: "What the model returned, before any human touched it.",
  },
  {
    title: "The gate decides: review queue or Triage",
    body: "Five questions, in order. The first failure decides where the invoice goes and which badge it wears. Triage is a separate list for human decisions: promote, trust the sender, reject or report. The review queue only ever holds real invoices from recognised, verified senders.",
    mock: <MockGate />,
    note: "The routing rules exactly as the backend applies them.",
  },
  {
    title: "A person codes and approves",
    body: "The reviewer picks the job number, cost code and approver from the company's own lists, sets the coding date, confirms vendor and project, and approves. The stamp preview shows what will be burned onto the PDF; it can be dragged anywhere on page 1. Members approve; admins post.",
    mock: <MockCoding />,
    note: "The review page's coding form and sticky footer.",
  },
  {
    title: "It posts to QuickBooks",
    body: "An admin posts from the Ready to post view. The bill lands on the matched vendor with one item-based line per invoice line, keyed to the Product/Service mapped from the cost code, allocated to the project, plus a sales-tax line so the total matches. The stamped PDF is attached. If anything fails, Retry resumes without creating a second bill.",
    mock: <MockBill />,
    note: "The bill as QuickBooks shows it.",
  },
];

function Lifecycle() {
  return (
    <section className="pt-20 md:pt-28">
      <SectionHeading
        id="lifecycle"
        title="How an invoice moves"
        lede="From the vendor's outbox to a coded bill in QuickBooks in five stages. Three are automatic, one is a human decision only when something is off, and one is the approval your people already do today, faster."
      />
      <ol className="space-y-14 md:space-y-20">
        {STAGES.map((s, i) => (
          <li key={s.title} className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 lg:gap-12 items-start">
            <div className="lg:sticky lg:top-20">
              <div className="flex items-baseline gap-4">
                <span className="font-display text-5xl text-amber leading-none">{i + 1}</span>
                <h3 className="font-display text-2xl md:text-3xl text-navy leading-tight">{s.title}</h3>
              </div>
              <p className="mt-4 text-base text-graphite/85 leading-relaxed max-w-prose">{s.body}</p>
            </div>
            <div>
              {s.mock}
              <Caption>{s.note}</Caption>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const GROUP_ORDER: Feature["group"][] = ["Intake", "Reading", "Trust", "Review", "Accounting", "Team"];

function Features() {
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="features"
        title="Every feature, and why a controller cares"
        lede="Grouped the way a prospect asks about them. Each one is in the product today."
      />
      <div className="space-y-12">
        {GROUP_ORDER.map((group) => (
          <div key={group} className="grid grid-cols-1 md:grid-cols-[10rem_1fr] gap-4 md:gap-8">
            <h3 className="font-display text-2xl text-navy md:pt-5">{group}</h3>
            <ul className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {FEATURES.filter((f) => f.group === group).map((f) => (
                <li key={f.title} className="bg-white border-l-2 border-amber px-5 py-4 shadow-sm">
                  <h4 className="font-semibold text-navy">{f.title}</h4>
                  <p className="mt-1.5 text-sm text-graphite/85 leading-relaxed">{f.what}</p>
                  <p className="mt-2 text-sm text-navy leading-relaxed">
                    <span className="font-semibold">Why it matters.</span> {f.why}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const ROLE_ROWS: [string, string, string, string][] = [
  ["Review, approve, reject any invoice", "Yes", "Yes", "Only assigned to them, after claiming"],
  ["Post to QuickBooks", "Yes", "Yes", "No"],
  ["Assign and reassign", "Yes", "Yes", "No"],
  ["Promote from Triage", "Yes", "Yes", "Yes"],
  ["Trust a sender for good", "Yes", "Yes", "No"],
  ["Invite and remove members", "Yes", "Yes", "No"],
  ["Remove an admin, grant owner", "Yes", "No", "No"],
  ["QuickBooks, coding lists, trusted senders, digest settings", "Yes", "Yes", "Read only"],
];

function Security() {
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="security"
        title="Fraud protection and control"
        lede="Invoice fraud works because a convincing PDF reaches someone who approves it. Here the PDF cannot get into the queue on its own: the sender must be known and the email must be verified. Everything else is a logged action by a named person with a defined role."
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-12">
        <div className="space-y-2">
          <MockIdentityBar verdict="trusted" />
          <Caption>Sender on the trusted list, email verified. Goes to the queue.</Caption>
        </div>
        <div className="space-y-2">
          <MockIdentityBar verdict="unknown" />
          <Caption>Personal Gmail address, not trusted. Waits in Triage. One click trusts this exact address, never all of Gmail.</Caption>
        </div>
        <div className="space-y-2">
          <MockIdentityBar verdict="failed" />
          <Caption>Looks like the vendor's domain but failed authentication: a likely forgery. Waits in Triage; the banner says to phone the vendor.</Caption>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <div>
          <h3 className="font-display text-2xl text-navy">Where trusted senders come from</h3>
          <ul className="mt-4 space-y-3 text-sm text-graphite/90 leading-relaxed">
            <li className="flex gap-3"><Badge tone="navy">QBO</Badge><span>Every vendor sync reads the email address on each QuickBooks vendor and trusts that domain. Entries disappear when the vendor's email goes away. Admins cannot delete these by hand; fix the vendor in QuickBooks.</span></li>
            <li className="flex gap-3"><Badge tone="amber">Manual</Badge><span>An admin adds a domain or address in Settings with a note, for partners who are not vendors in QuickBooks.</span></li>
            <li className="flex gap-3"><Badge tone="green">Triage</Badge><span>“Trust sender + promote” on a triage row trusts that sender and moves the invoice to the queue in one click. Audited with the invoice it came from.</span></li>
          </ul>
          <h3 className="font-display text-2xl text-navy mt-10">Report as suspicious</h3>
          <p className="mt-3 text-sm text-graphite/90 leading-relaxed">
            One button rejects the invoice and posts an alert to a chat channel with the sender,
            subject, amount, authentication result, triage reason and who reported it, linked back to
            the invoice. The rejection stands even if the alert cannot be delivered, and the activity
            log records whether it was.
          </p>
          <h3 className="font-display text-2xl text-navy mt-10">Also enforced</h3>
          <ul className="mt-3 space-y-2 text-sm text-graphite/90 leading-relaxed list-disc pl-5">
            <li>Posted invoices cannot be edited, rejected or re-read.</li>
            <li>Negative amounts are refused before approval; posting needs all four coding fields.</li>
            <li>The QuickBooks connection flow validates its state token within 30 minutes, blocking connection hijacks.</li>
            <li>Inbound webhooks are signature-checked with a five-minute replay window.</li>
            <li>PDF links expire after 15 minutes; AI keys never reach the browser.</li>
            <li>Access requests from the public page are throttled to five per hour per address and per IP.</li>
          </ul>
        </div>
        <div className="space-y-8">
          <div>
            <h3 className="font-display text-2xl text-navy mb-4">Three roles</h3>
            <Panel accent="none" className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-stone/60">
                    <th className="px-4 py-2 font-medium">Can…</th>
                    <th className="px-2 py-2 font-medium">Owner</th>
                    <th className="px-2 py-2 font-medium">Admin</th>
                    <th className="px-4 py-2 font-medium">Member</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLE_ROWS.map(([what, o, a, m]) => (
                    <tr key={what} className="border-b border-stone/50 text-graphite">
                      <td className="px-4 py-2">{what}</td>
                      <td className="px-2 py-2">{o}</td>
                      <td className="px-2 py-2">{a}</td>
                      <td className="px-4 py-2">{m}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Caption>Nobody can change their own role or remove themselves. Rules are enforced by the API, not only hidden in the interface.</Caption>
          </div>
          <div>
            <h3 className="font-display text-2xl text-navy mb-4">The activity log</h3>
            <MockActivity />
            <Caption>Thirty-seven kinds of event, each with actor, time and the changed fields. Rendered with the portal's own phrasing.</Caption>
          </div>
        </div>
      </div>
    </section>
  );
}

function Numbers() {
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="numbers"
        title="By the numbers"
        lede="These are the only figures to quote. They are constants in the code, not estimates. The product has no published volume or time-saved metrics."
      />
      <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-px bg-navy/10 border border-navy/10">
        {FIGURES.map((f) => (
          <li key={f.label} className="bg-stone p-5">
            <div className="font-display text-4xl text-navy leading-none">{f.value}</div>
            <div className="mt-2 text-sm text-graphite/85 leading-snug">{f.label}</div>
            <div className="mt-2 text-[11px] text-slate-500">{f.source}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConfigColumn({ title, lede, items }: { title: string; lede: string; items: ConfigItem[] }) {
  return (
    <div>
      <h3 className="font-display text-2xl text-navy">{title}</h3>
      <p className="mt-2 text-sm text-slate-600">{lede}</p>
      <dl className="mt-4 divide-y divide-navy/10 border-t border-navy/10">
        {items.map((it) => (
          <div key={it.item} className="py-3">
            <dt className="font-semibold text-navy text-sm">{it.item}</dt>
            <dd className="mt-0.5 text-sm text-graphite/85 leading-relaxed">{it.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Configure() {
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="configure"
        title="What is yours to configure"
        lede="A deployment is one company, one QuickBooks file, one team. The first two columns are set up for each company; the third is what is still Cambridge-specific in the code today and would be adapted for a new customer."
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <ConfigColumn title="At setup" lede="Server configuration done once by whoever hosts it." items={CONFIG_ENV} />
        <ConfigColumn title="In Settings, by your admins" lede="Changed any time, logged in Activity." items={CONFIG_UI} />
        <ConfigColumn title="Cambridge-specific today" lede="Changes to the code or assets for a white-label customer." items={CONFIG_CAMBRIDGE} />
      </div>
    </section>
  );
}

function Questions() {
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="faq"
        title="Questions prospects ask"
        lede="Answers a controller can check against the product. The last one is the list of what it does not do."
      />
      <div className="max-w-3xl divide-y divide-navy/10 border-y border-navy/10">
        {FAQ.map((f) => (
          <details key={f.q} className="group">
            <summary className="cursor-pointer list-none py-4 pr-8 relative font-semibold text-navy text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
              {f.q}
              <span className="absolute right-0 top-4 text-amber transition-transform group-open:rotate-45" aria-hidden>+</span>
            </summary>
            <p className="pb-5 text-sm text-graphite/85 leading-relaxed max-w-prose">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Demo() {
  const text = DEMO_SCRIPT.map((s, i) => `${i + 1}. ${s.title}\n   Do: ${s.click}\n   Say: ${s.say}`).join("\n\n");
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="demo"
        title="A live demo in nine steps"
        lede="About fifteen minutes with a sandbox QuickBooks company connected. Send yourself one invoice from a trusted vendor address and one from a personal address before you start."
      />
      <div className="flex flex-wrap gap-3 mb-8">
        <CopyButton text={text} label="Copy the script" tone="outline" />
      </div>
      <ol className="space-y-6 max-w-4xl">
        {DEMO_SCRIPT.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[2.5rem_1fr] gap-4">
            <span className="font-display text-3xl text-amber leading-none pt-1">{i + 1}</span>
            <div className="bg-white shadow-sm">
              <h3 className="px-5 pt-4 font-semibold text-navy">{s.title}</h3>
              <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm leading-relaxed">
                <div>
                  <div className="text-xs font-bold uppercase tracking-widest text-amber mb-1">Do</div>
                  <p className="text-graphite/85">{s.click}</p>
                </div>
                <div className="md:border-l md:border-stone md:pl-4">
                  <div className="text-xs font-bold uppercase tracking-widest text-amber mb-1">Say</div>
                  <p className="text-graphite font-medium">“{s.say}”</p>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Reference() {
  const [open, setOpen] = useState(false);
  return (
    <section className="pt-24 md:pt-32">
      <SectionHeading
        id="reference"
        title="Take it with you"
        lede="The talking points, and the full feature reference the whole page is built from."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <div>
          <h3 className="font-display text-2xl text-navy">Talking points</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-graphite/90 leading-relaxed">
            {TALKING_POINTS.map((p) => (
              <li key={p} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 bg-amber flex-shrink-0" aria-hidden />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <CopyButton text={talkingPointsText()} label="Copy talking points" />
          </div>
        </div>
        <div>
          <h3 className="font-display text-2xl text-navy">Complete feature reference</h3>
          <p className="mt-3 text-sm text-graphite/85 leading-relaxed">
            Nineteen sections covering every status, triage reason, permission, QuickBooks field and
            configuration switch, plus the honest list of limits. Written from the code so any
            prospect question can be answered precisely.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => downloadText("invoice-portal-feature-reference.md", featureReference)}
              className="inline-flex items-center gap-2 bg-amber text-navy font-semibold px-4 py-2.5 text-sm hover:bg-amber/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
            >
              <DocumentArrowDownIcon className="h-4 w-4" aria-hidden />
              Download as Markdown
            </button>
            <CopyButton text={featureReference} label="Copy the whole reference" tone="outline" />
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-2 text-navy font-semibold px-4 py-2.5 text-sm hover:bg-navy/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              aria-expanded={open}
            >
              {open ? "Hide the text" : "Read it here"}
            </button>
          </div>
          {open && (
            <pre className="mt-5 max-h-[32rem] overflow-auto bg-white border border-navy/10 p-5 text-xs leading-relaxed whitespace-pre-wrap font-mono text-graphite">
              {featureReference}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}
