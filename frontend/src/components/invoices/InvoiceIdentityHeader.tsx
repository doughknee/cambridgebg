/**
 * The single navy bar at the top of the review page. Consolidates what
 * used to be three stacked elements + a duplicated card:
 *   - the generic "Review Invoice" page header,
 *   - the standalone "Assigned to…" chip row, and
 *   - the navy Vendor/Total card rendered inside BOTH the edit form and
 *     the read-only summary.
 *
 * Vendor + total update live while editing (the route feeds the form's
 * working values in via vendorLabel/totalCents), so this stays the single
 * source of "what am I looking at."
 */
import type { Invoice } from "@/types";
import { getStatusMeta } from "@/components/invoices/StatusBadge";
import { formatCents, formatDate } from "@/lib/format";

function initials(source: string): string {
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Who actually sent this email and whether we recognise them. Shown on
 * every email-sourced invoice, not just triage rows, so the source is
 * one glance away (REL-692).
 */
function SenderLine({ invoice }: { invoice: Invoice }) {
  const authFailed = /=fail\b/.test(invoice.email_auth ?? "");
  let verdict: { text: string; className: string } | null = null;
  if (authFailed) {
    verdict = { text: "failed sender verification", className: "text-red-300" };
  } else if (invoice.sender_trusted === true) {
    verdict = { text: "trusted sender", className: "text-green-300" };
  } else if (invoice.sender_trusted === false) {
    verdict = { text: "unknown sender", className: "text-amber" };
  }
  return (
    <div className="mt-1 text-xs text-stone/60 flex flex-wrap items-center gap-x-2">
      <span className="min-w-0 truncate">
        From <span className="text-stone font-medium">{invoice.sender_email ?? "unknown address"}</span>
      </span>
      {verdict && (
        <>
          <span className="text-stone/30">·</span>
          <span className={`${verdict.className} whitespace-nowrap`} title={invoice.email_auth ?? undefined}>
            {verdict.text}
          </span>
        </>
      )}
    </div>
  );
}

export function InvoiceIdentityHeader({
  invoice,
  vendorLabel,
  totalCents,
  currency,
  onBack,
  canManage,
  showAssignActions,
  onReassign,
  onRemove,
  onNotify,
}: {
  invoice: Invoice;
  vendorLabel: string;
  totalCents: number | null;
  currency: string;
  onBack: () => void;
  canManage: boolean;
  showAssignActions: boolean;
  onReassign: () => void;
  onRemove: () => void;
  onNotify: () => void;
}) {
  const status = getStatusMeta(invoice.status);
  const assigneeLabel =
    invoice.assigned_to_name || invoice.assigned_to_email || invoice.assigned_to_id;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onBack}
        className="hidden md:inline-flex items-center gap-1 mb-3 text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-navy"
      >
        ← Queue
      </button>

      <div className="relative overflow-hidden bg-navy text-stone border-t-4 border-amber">
        <div className="absolute inset-0 bg-grid opacity-50 pointer-events-none" aria-hidden />
        <div className="relative p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-amber mb-1">
                Vendor
              </div>
              <h1 className="font-display text-2xl sm:text-3xl leading-tight truncate">
                {vendorLabel || <span className="text-stone/50 italic">Unassigned</span>}
              </h1>
              <div className="mt-1.5 text-xs text-stone/60 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {invoice.invoice_number && (
                  <>
                    <span className="font-mono">#{invoice.invoice_number}</span>
                    <span className="text-stone/30">·</span>
                  </>
                )}
                <span>Received {formatDate(invoice.received_at)}</span>
                {invoice.job_number && (
                  <>
                    <span className="text-stone/30">·</span>
                    <span>Job {invoice.job_number}</span>
                  </>
                )}
              </div>
              {invoice.source === "email" && <SenderLine invoice={invoice} />}
            </div>

            <div className="text-right flex-shrink-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-amber mb-1">
                Total
              </div>
              <div className="font-display text-2xl sm:text-3xl leading-none tabular-nums">
                {formatCents(totalCents, currency)}
              </div>
              <div className="mt-2.5 flex justify-end">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide border border-stone/35 text-stone">
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: status.dotColor ?? "#c8923c" }}
                  />
                  {status.label}
                </span>
              </div>
            </div>
          </div>

          {assigneeLabel && (
            <div className="mt-4 pt-3 border-t border-stone/15 flex items-center gap-2.5 text-xs">
              <span className="inline-flex items-center justify-center h-6 w-6 bg-amber text-navy text-[10px] font-semibold flex-shrink-0">
                {initials(assigneeLabel)}
              </span>
              <span className="text-stone/60 min-w-0 truncate">
                Assigned to <span className="text-stone font-medium">{assigneeLabel}</span>
                {invoice.claimed_at ? (
                  <span className="text-green-300 whitespace-nowrap"> · claimed</span>
                ) : (
                  <span className="text-amber/90 whitespace-nowrap"> · not opened yet</span>
                )}
              </span>
              {canManage && showAssignActions && (
                <span className="ml-auto flex items-center gap-3 flex-shrink-0">
                  <button
                    type="button"
                    onClick={onReassign}
                    className="text-stone/60 hover:text-stone"
                  >
                    Reassign
                  </button>
                  <button
                    type="button"
                    onClick={onRemove}
                    className="text-stone/60 hover:text-red-300"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={onNotify}
                    className="text-stone/60 hover:text-amber"
                  >
                    Notify
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
