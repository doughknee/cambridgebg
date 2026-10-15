import { Badge } from "@/components/ui/Badge";
import type {
  DocumentType,
  Invoice,
  InvoiceStatus,
  TriageReason,
} from "@/types";

/**
 * Primary status badge — the one-glance signal of where an invoice sits.
 *
 * The dot color is the fastest visual cue when the badge text is truncated.
 * Tones use higher-contrast borders + text colors so chips read clearly on
 * small phone screens against the stone bg.
 *
 * Pending (the old "in flight" status) was removed in favor of the queue's
 * Need Review / Assigned tabs — workflow stage now lives in the assignment
 * and active filter, not in a separate status value.
 */
const STATUS_CONFIG: Record<
  InvoiceStatus,
  {
    tone: React.ComponentProps<typeof Badge>["tone"];
    label: string;
    /** Hex used for the leading dot — overrides the default amber. */
    dotColor?: string;
    /** Pulse animation on the dot for in-flight states. */
    pulseDot?: boolean;
  }
> = {
  received: { tone: "slate", label: "Received", dotColor: "#64748b" },
  extracting: {
    tone: "blue",
    label: "Extracting",
    dotColor: "#1d4ed8",
    pulseDot: true,
  },
  extraction_failed: {
    tone: "red",
    label: "Extraction failed",
    dotColor: "#b91c1c",
  },
  ready_for_review: {
    tone: "amber",
    label: "Needs review",
    dotColor: "#c8923c",
  },
  needs_triage: {
    tone: "amber",
    label: "Triage",
    dotColor: "#9a6324",
  },
  approved: { tone: "green", label: "Approved", dotColor: "#15803d" },
  posted_to_qbo: { tone: "navy", label: "Posted", dotColor: "#c8923c" },
  rejected: { tone: "red", label: "Rejected", dotColor: "#7f1d1d" },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const cfg =
    STATUS_CONFIG[status] ?? { tone: "slate" as const, label: status };
  return (
    <Badge tone={cfg.tone} dot dotColor={cfg.dotColor} pulseDot={cfg.pulseDot}>
      {cfg.label}
    </Badge>
  );
}

/**
 * Status label + dot color, for rendering a status pill on custom (dark)
 * backgrounds — e.g. the navy identity header — where the standard
 * light-fill Badge tones (amber/navy) don't have enough contrast.
 */
export function getStatusMeta(status: InvoiceStatus): {
  label: string;
  dotColor?: string;
  pulseDot?: boolean;
} {
  const cfg = STATUS_CONFIG[status];
  return cfg
    ? { label: cfg.label, dotColor: cfg.dotColor, pulseDot: cfg.pulseDot }
    : { label: status };
}

/**
 * Compact secondary indicator that adds context to an "approved" row inside
 * the merged Approved tab. Renders nothing for invoices in any other state.
 *
 *   - approved + qbo_post_error → red "Post failed"
 *   - approved + no bill_id     → muted "Pending post"
 *   - posted_to_qbo             → navy "#1234" (the QBO bill number,
 *                                  if present)
 *   - rejected with reason in notes → handled separately on the detail page,
 *                                     not here.
 */
export function PostStateBadge({ invoice }: { invoice: Pick<Invoice, "status" | "qbo_bill_id" | "qbo_post_error"> }) {
  if (invoice.status === "approved") {
    if (invoice.qbo_post_error) {
      return (
        <Badge tone="red" dot dotColor="#b91c1c">
          Post failed
        </Badge>
      );
    }
    if (!invoice.qbo_bill_id) {
      return (
        <Badge tone="slate" dot dotColor="#94a3b8">
          Pending post
        </Badge>
      );
    }
  }
  if (invoice.status === "posted_to_qbo" && invoice.qbo_bill_id) {
    return (
      <Badge tone="navy">
        <span className="font-mono">#{invoice.qbo_bill_id}</span>
      </Badge>
    );
  }
  return null;
}

/**
 * Why an invoice landed in NEEDS_TRIAGE. Shown alongside StatusBadge in
 * the queue's Triage tab and at the top of the review page so AP can
 * decide what action to take without having to open every row.
 *
 * Each reason maps to a distinct color so a glance at the queue is
 * enough to triage by category (all encrypted-PDF rows in red, all
 * statement-style misclassifications in slate, etc).
 */
const TRIAGE_REASON_CONFIG: Record<
  TriageReason,
  { tone: React.ComponentProps<typeof Badge>["tone"]; label: string; dotColor?: string }
> = {
  non_invoice: {
    tone: "slate",
    label: "Not an invoice",
    dotColor: "#64748b",
  },
  unknown_sender: {
    tone: "amber",
    label: "Unknown sender",
    dotColor: "#9a6324",
  },
  body_rendered: {
    tone: "blue",
    label: "From email body",
    dotColor: "#1d4ed8",
  },
  encrypted_pdf: {
    tone: "red",
    label: "Encrypted PDF",
    dotColor: "#b91c1c",
  },
  low_confidence: {
    tone: "amber",
    label: "Low confidence",
    dotColor: "#c8923c",
  },
  auth_failed: {
    tone: "red",
    label: "Failed sender verification",
    dotColor: "#b91c1c",
  },
};

export function TriageReasonBadge({ reason }: { reason: TriageReason }) {
  const cfg = TRIAGE_REASON_CONFIG[reason];
  if (!cfg) return null;
  return (
    <Badge tone={cfg.tone} dot dotColor={cfg.dotColor}>
      {cfg.label}
    </Badge>
  );
}

/**
 * Compact label for ``document_type`` — shown in triage rows alongside
 * the reason badge so AP can see "Statement (not an invoice)" at a
 * glance. Returns null for ``invoice`` and ``unknown`` since neither
 * adds useful context: the latter is the default, the former is the
 * happy path.
 */
const DOCUMENT_TYPE_LABEL: Record<DocumentType, string | null> = {
  invoice: null,
  statement: "Statement",
  quote: "Quote",
  order_ack: "Order ack",
  receipt: "Receipt",
  supporting_doc: "Supporting doc",
  other: "Other",
  unknown: null,
};

export function DocumentTypeBadge({ type }: { type: DocumentType }) {
  const label = DOCUMENT_TYPE_LABEL[type];
  if (!label) return null;
  return <Badge tone="slate">{label}</Badge>;
}
