import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  UserPlusIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
// ClockIcon stays in scope below — used in the StatusBanner for the
// "approved but QBO disconnected" case.
import { useMobileAppBar } from "@/components/layout/MobileAppBar";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { SplitButton, type SplitButtonOption } from "@/components/ui/SplitButton";
import {
  DocumentTypeBadge,
  TriageReasonBadge,
} from "@/components/invoices/StatusBadge";
import { InvoiceIdentityHeader } from "@/components/invoices/InvoiceIdentityHeader";
import { PdfViewer } from "@/components/invoices/PdfViewer";
import { ExtractedFieldsForm } from "@/components/invoices/ExtractedFieldsForm";
import { StampPreviewOverlay, type StampPosition } from "@/components/invoices/StampPreview";
import { InvoiceSummary } from "@/components/invoices/InvoiceSummary";
import { AssigneePicker } from "@/components/invoices/AssigneePicker";
import { NotifyModal } from "@/components/invoices/NotifyModal";
import {
  useApproveAndPostInvoice,
  useApproveInvoice,
  useAssignInvoice,
  useClaimInvoice,
  useInvoice,
  usePatchInvoice,
  usePostInvoice,
  useProjects,
  usePromoteFromTriage,
  useReextractInvoice,
  useRejectInvoice,
  useReportInvoice,
  useTrustSenderAndPromote,
  useUnapproveInvoice,
  useUnassignInvoice,
  useVendors,
  type InvoicePatchPayload,
} from "@/lib/invoices";
import { ROLE_RANK, useMe } from "@/lib/users";
import type { TeamMember } from "@/lib/users";
import type { Invoice, Project, QboStatus, Vendor } from "@/types";
import { useQboStatus } from "@/lib/qbo";
import { qboBillUrl } from "@/lib/qboUrls";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_authed/invoices_/$id")({
  component: InvoiceDetailPage,
});

// ──────────────────────────────────────────────────────────────────────────
// The review page has two macro-modes:
//   • "review" — status=ready_for_review / extraction_failed / received /
//                extracting. Editable form.
//   • "locked" — status=approved / posted_to_qbo / rejected. Read-only
//                summary + Edit for approved (which unapproves it first).
// ──────────────────────────────────────────────────────────────────────────

type Mode = "review" | "locked";

function InvoiceDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  // Short burst-poll after a Post action so we see status flip to posted_to_qbo
  const [burstPoll, setBurstPoll] = useState(false);
  const invoiceQuery = useInvoice(id, { burstPoll });
  const vendorsQuery = useVendors();
  const projectsQuery = useProjects();
  const qboQuery = useQboStatus();
  const meQuery = useMe();

  const patch = usePatchInvoice(id);
  const approve = useApproveInvoice(id);
  const approveAndPost = useApproveAndPostInvoice(id);
  const postOnly = usePostInvoice(id);
  const unapprove = useUnapproveInvoice(id);
  const assign = useAssignInvoice(id);
  const unassign = useUnassignInvoice(id);
  const reject = useRejectInvoice(id);
  const report = useReportInvoice(id);
  const reextract = useReextractInvoice(id);
  const claim = useClaimInvoice(id);

  // Buffer the latest unsaved patch payload from ExtractedFieldsForm so we
  // can flush it on approve/post without re-rendering on every keystroke.
  // Named `pendingPatch` to disambiguate from the (now-removed) Pending
  // workflow status.
  const pendingPatch = useRef<InvoicePatchPayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [forceEdit, setForceEdit] = useState(false);

  // Live AP coding draft — only the 4 fields the stamp preview needs.
  // Subscribed via onCodingChange so the rest of the form keeps its
  // ref-based "no re-render on keystroke" optimization. Starts empty
  // and gets populated when ExtractedFieldsForm mounts (which fires
  // onCodingChange with the invoice's current values).
  const [codingDraft, setCodingDraft] = useState({
    job_number: "",
    cost_code: "",
    coding_date: "",
    approver: "",
  });

  // Refs to the rendered PDF page, used as the anchor for the
  // draggable stamp overlay. We resolve via querySelector after each
  // render because react-pdf's Page DOM appears asynchronously.
  const pdfColumnRef = useRef<HTMLDivElement>(null);
  const [pageEl, setPageEl] = useState<HTMLElement | null>(null);
  const [currentPdfPage, setCurrentPdfPage] = useState(1);

  // Live stamp position — falls back to invoice.stamp_position when
  // unset, then to default top-right inside the overlay component.
  const [stampPosition, setStampPosition] = useState<StampPosition | null>(null);
  // Sync from the invoice when it loads / refreshes
  useEffect(() => {
    if (invoiceQuery.data?.stamp_position) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync stamp position from the loaded invoice
      setStampPosition(invoiceQuery.data.stamp_position);
    }
  }, [invoiceQuery.data?.stamp_position]);

  const [rejectReason, setRejectReason] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showNotify, setShowNotify] = useState(false);
  // Human-readable reason the last review action failed (backend 4xx detail).
  const [actionError, setActionError] = useState<string | null>(null);

  // Assignment modals — one flow per action that needs an assignee.
  const [assignFlow, setAssignFlow] = useState<
    null | "assign" | "reassign"
  >(null);

  // Live vendor + total from the edit form, so the identity header reflects
  // unsaved edits. Null while not editing — header falls back to saved values.
  const [headerDraft, setHeaderDraft] = useState<{
    vendorLabel: string;
    totalCents: number | null;
    currency: string;
  } | null>(null);

  const invoice = invoiceQuery.data;
  const me = meQuery.data;
  const myRole = me?.role ?? "member";
  const isAdmin = ROLE_RANK[myRole] >= ROLE_RANK.admin;
  const canManageAssignments = isAdmin;
  const isAssignee = !!invoice && !!me && invoice.assigned_to_id === me.id;
  const isClaimed = !!invoice?.claimed_at;
  // Admins review/act on any invoice directly; a member must be the assignee
  // AND have claimed it (the signal that they've taken ownership).
  const canReviewActions = !!me && (isAdmin || (isAssignee && isClaimed));

  // Mobile app-bar title: the vendor, so you know which invoice you're on
  // without scrolling. Falls back to "Review" before it loads.
  const mobileTitle =
    (invoice &&
      (vendorsQuery.data?.vendors.find((v) => v.id === invoice.vendor_id)?.display_name ||
        invoice.vendor_name)) ||
    "Review";
  useMobileAppBar({
    title: mobileTitle,
    action: (
      <button
        type="button"
        onClick={() => navigate({ to: "/invoices" })}
        className="inline-flex items-center min-h-[36px] px-3 text-xs font-bold uppercase tracking-wider text-navy hover:text-amber"
        aria-label="Back to queue"
      >
        ← Queue
      </button>
    ),
  });

  const mode: Mode = useMemo(() => {
    if (!invoice) return "review";
    if (
      invoice.status === "ready_for_review" ||
      invoice.status === "extraction_failed" ||
      invoice.status === "received" ||
      invoice.status === "extracting" ||
      // needs_triage stays in review mode so AP can edit fields before
      // promoting (reason banner adds Promote / Trust+promote buttons).
      invoice.status === "needs_triage"
    ) {
      return "review";
    }
    return "locked";
  }, [invoice]);

  const showEditor = mode === "review" || forceEdit;

  // Stop the burst poll once the post resolves: either status flipped to
  // posted_to_qbo / rejected / etc, OR qbo_post_error appeared.
  useEffect(() => {
    if (!invoice) return;
    if (
      burstPoll &&
      (invoice.status !== "approved" || invoice.qbo_post_error)
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- stop the burst poll once the post resolves
      setBurstPoll(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on specific fields, not the whole invoice object
  }, [invoice?.status, invoice?.qbo_post_error, burstPoll]);

  // True while a QBO post is in flight — the POST returned quickly but the
  // backend task is still running. Drives the perpetual loading indicator.
  const postingInFlight =
    postOnly.isPending ||
    approveAndPost.isPending ||
    (burstPoll &&
      invoice?.status === "approved" &&
      !invoice?.qbo_bill_id &&
      !invoice?.qbo_post_error);

  // Keyboard shortcuts — context-aware
  //   ⌘+Enter        : primary action (Approve in review mode, Post when
  //                    already approved)
  //   ⌘+Shift+Enter  : Approve & Post in review mode
  //   ⌘+Shift+R      : open reject modal
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!invoice) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "Enter" && !e.shiftKey) {
        if (!canReviewActions) return;
        e.preventDefault();
        if (mode === "review") void handleApprove();
        else if (invoice.status === "approved") void handlePost();
      } else if (e.key === "Enter" && e.shiftKey) {
        if (!canReviewActions) return;
        e.preventDefault();
        if (mode === "review") void handleApproveAndPost();
      } else if (e.shiftKey && (e.key === "R" || e.key === "r")) {
        if (!canReviewActions) return;
        e.preventDefault();
        setShowRejectModal(true);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice, mode, canReviewActions]);

  if (invoiceQuery.isLoading) {
    return <LoadingState message="Loading invoice…" />;
  }
  if (invoiceQuery.error || !invoice) {
    return (
      <ErrorState
        title="Couldn't load invoice"
        message={
          (invoiceQuery.error as Error | null)?.message ??
          "This invoice may have been removed."
        }
        onRetry={() => void invoiceQuery.refetch()}
      />
    );
  }

  const qboConnected = qboQuery.data?.connected ?? false;
  const busy =
    patch.isPending ||
    approve.isPending ||
    approveAndPost.isPending ||
    postOnly.isPending ||
    unapprove.isPending ||
    assign.isPending ||
    unassign.isPending ||
    reject.isPending ||
    report.isPending ||
    reextract.isPending ||
    claim.isPending;

  async function flushDirty() {
    if (dirty && pendingPatch.current) {
      await patch.mutateAsync(pendingPatch.current);
      setDirty(false);
    }
  }

  // Failures from review actions used to vanish (unhandled promise rejection)
  // — the user clicked Post/Approve and nothing visibly happened while the
  // backend's 4xx explained exactly what to fix. Route every action through
  // this guard so the reason lands in a visible banner.
  async function guarded(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Something went wrong — please try again.",
      );
    }
  }

  async function handleApprove() {
    await guarded(async () => {
      await flushDirty();
      await approve.mutateAsync();
      setForceEdit(false);
    });
  }

  async function handleApproveAndPost() {
    if (!qboConnected) return;
    await guarded(async () => {
      await flushDirty();
      await approveAndPost.mutateAsync();
      setBurstPoll(true);
      setForceEdit(false);
    });
  }

  async function handleAssign(member: TeamMember | null, notify: boolean) {
    if (!member) {
      setAssignFlow(null);
      return;
    }
    await guarded(async () => {
      await flushDirty();
      await assign.mutateAsync({
        user_id: member.id,
        user_email: member.email,
        user_name: member.name,
        notify,
      });
      setForceEdit(false);
    });
    // Close either way — on failure the error banner sits behind the picker
    // sheet, so leaving it open would hide the explanation.
    setAssignFlow(null);
  }

  async function handleClaim() {
    await guarded(() => claim.mutateAsync());
  }

  async function handlePost() {
    await guarded(async () => {
      await postOnly.mutateAsync();
      setBurstPoll(true);
    });
  }

  async function handleReassign(member: TeamMember | null, notify: boolean) {
    if (!member) {
      setAssignFlow(null);
      return;
    }
    await guarded(async () => {
      await flushDirty();
      await assign.mutateAsync({
        user_id: member.id,
        user_email: member.email,
        user_name: member.name,
        notify,
      });
    });
    // Close either way — see handleAssign.
    setAssignFlow(null);
  }

  async function handleReject() {
    if (!rejectReason.trim()) return;
    await guarded(async () => {
      await reject.mutateAsync(rejectReason.trim());
      setRejectReason("");
    });
    // Close either way — on failure the banner explains what went wrong;
    // leaving the modal open would hide it.
    setShowRejectModal(false);
  }

  async function handleReport() {
    await guarded(() => report.mutateAsync());
    setShowReportModal(false);
  }

  async function handleUnapprove() {
    await guarded(async () => {
      await unapprove.mutateAsync();
      setForceEdit(true);
    });
  }

  async function handleEdit() {
    // For APPROVED, this unapproves first. For POSTED_TO_QBO, we don't
    // allow edits (no button rendered). For extraction_failed the form is
    // already editable.
    if (invoice?.status === "approved") {
      await handleUnapprove();
    } else {
      setForceEdit(true);
    }
  }

  const pickerTitle: Record<NonNullable<typeof assignFlow>, string> = {
    assign: "Assign invoice",
    reassign: "Reassign invoice",
  };
  const pickerDescription: Record<NonNullable<typeof assignFlow>, string> = {
    assign: "Choose who should review and approve this invoice.",
    reassign: "Move this invoice to a different team member.",
  };
  const pickerConfirm: Record<NonNullable<typeof assignFlow>, string> = {
    assign: "Assign",
    reassign: "Reassign",
  };

  async function onPickerSelect(
    member: TeamMember | null,
    opts: { notify: boolean } = { notify: true },
  ) {
    if (!assignFlow) return;
    if (assignFlow === "assign") await handleAssign(member, opts.notify);
    else if (assignFlow === "reassign") await handleReassign(member, opts.notify);
  }

  const resolvedVendorName =
    vendorsQuery.data?.vendors.find((v) => v.id === invoice.vendor_id)?.display_name ||
    invoice.vendor_name ||
    "";
  const headerVendor =
    showEditor && headerDraft ? headerDraft.vendorLabel : resolvedVendorName;
  const headerTotalCents =
    showEditor && headerDraft ? headerDraft.totalCents : invoice.total_cents;
  const headerCurrency =
    showEditor && headerDraft ? headerDraft.currency : invoice.currency;

  return (
    <>
      <InvoiceIdentityHeader
        invoice={invoice}
        vendorLabel={headerVendor}
        totalCents={headerTotalCents}
        currency={headerCurrency}
        onBack={() => navigate({ to: "/invoices" })}
        canManage={canManageAssignments}
        showAssignActions={mode === "review" || invoice.status === "approved"}
        onReassign={() => setAssignFlow("reassign")}
        onRemove={() => void guarded(() => unassign.mutateAsync())}
        onNotify={() => setShowNotify(true)}
      />

      {/* Why the last action was rejected — dismissable, replaced on retry. */}
      {actionError && (
        <div className="mb-4 p-4 border-l-2 border-red-700 bg-red-50 flex items-start gap-3">
          <ExclamationTriangleIcon className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-red-900">{actionError}</div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="p-1 -m-1 text-red-700 hover:text-red-900 flex-shrink-0"
            aria-label="Dismiss"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Context banners */}
      <StatusBanner
        invoice={invoice}
        qbo={qboQuery.data}
        qboConnected={qboConnected}
        isAdmin={isAdmin}
        onReject={() => setShowRejectModal(true)}
        onReport={() => setShowReportModal(true)}
      >
        {invoice.status === "extraction_failed" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void guarded(() => reextract.mutateAsync())}
            loading={reextract.isPending}
          >
            <ArrowPathIcon className="h-4 w-4" />
            Re-extract
          </Button>
        )}
        {invoice.status === "approved" && invoice.qbo_post_error && isAdmin && (
          <Button
            variant="primary"
            size="sm"
            onClick={handlePost}
            loading={postOnly.isPending}
          >
            <ArrowPathIcon className="h-4 w-4" />
            Retry post to QBO
          </Button>
        )}
      </StatusBanner>

      {/* Two-column on lg+; PDF on top, form below on smaller screens. */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 md:gap-6">
        {/* min-w-0 on both columns lets the grid actually shrink them to
            their 60/40 share. Without it, the line-items table's
            `min-w-[460px]` (intentional for inner horizontal scroll on
            mobile) propagates upward and forces the whole grid wider
            than the viewport, causing horizontal page scroll. */}
        <div
          ref={pdfColumnRef}
          className="relative min-w-0 lg:col-span-3 h-[55vh] sm:h-[65vh] lg:h-[calc(100vh-16rem)] lg:min-h-[600px]"
        >
          <PdfViewer
            invoiceId={id}
            downloadUrl={invoice.pdf_url ?? undefined}
            onPageChange={setCurrentPdfPage}
          />
          {/* Find the rendered PDF page element so the stamp overlay
              can position itself relative to actual page geometry, not
              the surrounding viewport / scroll area. */}
          <PageAnchor
            columnRef={pdfColumnRef}
            currentPage={currentPdfPage}
            invoiceUrl={invoice.pdf_url ?? null}
            onElement={setPageEl}
          />
          {/* Live stamp overlay. Only rendered when the user is editing
              and on page 1 (the only page the stamp lands on). When
              not editable (locked invoices), no handles, no drag —
              just the static visual. */}
          {pageEl && currentPdfPage === 1 && (
            <StampPreviewOverlay
              invoice={codingDraft}
              containerRef={{ current: pageEl }}
              position={stampPosition}
              editable={showEditor}
              onChange={(next) => {
                setStampPosition(next);
                if (next) {
                  // Persist immediately on drag-release. PATCH is
                  // idempotent and small enough that we don't need
                  // to debounce.
                  patch.mutate({ stamp_position: next });
                }
              }}
            />
          )}
          {/* Reset-to-default button when the user has moved the stamp */}
          {showEditor && stampPosition && pageEl && currentPdfPage === 1 && (
            <button
              type="button"
              onClick={() => {
                setStampPosition(null);
                patch.mutate({ stamp_position: null });
              }}
              className="absolute bottom-3 right-3 z-[15] text-[10px] uppercase tracking-wider font-bold bg-white/95 text-navy hover:bg-amber px-2 py-1 border border-navy shadow"
            >
              Reset stamp
            </button>
          )}
        </div>

        <div className="min-w-0 lg:col-span-2">
          {invoice.status === "extracting" || invoice.status === "received" ? (
            <div className="text-center py-16 bg-white border-l-2 border-amber/60">
              <div
                aria-hidden
                className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-navy border-r-transparent"
              />
              <p className="mt-3 text-sm text-slate-600">
                Extracting invoice fields…
              </p>
            </div>
          ) : showEditor ? (
            <ExtractedFieldsForm
              invoice={invoice}
              vendors={vendorsQuery.data?.vendors ?? []}
              projects={projectsQuery.data?.projects ?? []}
              onChange={(p) => {
                pendingPatch.current = p;
                setDirty(true);
              }}
              onCodingChange={setCodingDraft}
              onSummaryChange={setHeaderDraft}
              disabled={!canReviewActions}
            />
          ) : (
            <ReadOnlyView
              invoice={invoice}
              vendors={vendorsQuery.data?.vendors ?? []}
              projects={projectsQuery.data?.projects ?? []}
              onEdit={handleEdit}
              editBusy={unapprove.isPending}
              canEdit={canReviewActions}
            />
          )}
        </div>
      </div>

      {/* Sticky action footer */}
      {(showEditor || invoice.status === "approved") && (
        <ActionFooter
          invoice={invoice}
          dirty={dirty}
          busy={busy}
          qboConnected={qboConnected}
          forceEdit={forceEdit}
          showEditor={showEditor}
          postingInFlight={!!postingInFlight}
          onSave={async () => {
            await flushDirty();
          }}
          onCancelEdit={() => {
            setForceEdit(false);
            setDirty(false);
            pendingPatch.current = null;
          }}
          onReject={() => setShowRejectModal(true)}
          onReport={() => setShowReportModal(true)}
          onApprove={handleApprove}
          onApproveAndPost={handleApproveAndPost}
          onAssign={() => setAssignFlow(invoice.assigned_to_id ? "reassign" : "assign")}
          onPost={handlePost}
          onUnapprove={handleUnapprove}
          onClaim={handleClaim}
          patchPending={patch.isPending}
          isAdmin={isAdmin}
          isAssignee={isAssignee}
          isClaimed={isClaimed}
        />
      )}

      {/* Reject modal */}
      <BottomSheet
        open={showRejectModal}
        onClose={() => setShowRejectModal(false)}
        ariaLabel="Reject invoice"
      >
        <div className="p-6">
          <h2 className="font-display text-2xl text-navy">Reject invoice</h2>
          <p className="text-sm text-slate-600 mt-1">
            Provide a reason. This is saved to the audit log.
          </p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
            placeholder="e.g. Duplicate of invoice #INV-2025-12"
            className="mt-4 block w-full p-3 border border-slate-300 bg-stone/50 text-base md:text-sm focus:outline-none focus:border-amber focus:ring-1 focus:ring-amber"
          />
        </div>
        <div className="px-6 py-4 bg-stone/50 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 border-t border-stone">
          <Button variant="ghost" onClick={() => setShowRejectModal(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleReject}
            disabled={!rejectReason.trim()}
            loading={reject.isPending}
          >
            Reject
          </Button>
        </div>
      </BottomSheet>

      {/* Report-as-suspicious modal */}
      <BottomSheet
        open={showReportModal}
        onClose={() => setShowReportModal(false)}
        ariaLabel="Report invoice as suspicious"
      >
        <div className="p-6">
          <h2 className="font-display text-2xl text-navy">Report as suspicious</h2>
          <p className="text-sm text-slate-600 mt-1">
            This rejects the invoice and sends the sender, subject, and a link to
            RelentNet so we can look into it. You don't need to do anything else.
          </p>
          {invoice.sender_email && (
            <p className="mt-3 text-xs text-slate-500">
              From <span className="font-mono text-graphite">{invoice.sender_email}</span>
            </p>
          )}
        </div>
        <div className="px-6 py-4 bg-stone/50 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 border-t border-stone">
          <Button variant="ghost" onClick={() => setShowReportModal(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleReport} loading={report.isPending}>
            Report and reject
          </Button>
        </div>
      </BottomSheet>

      {/* Assignee picker (shared for all assign flows) */}
      <AssigneePicker
        open={assignFlow !== null}
        title={assignFlow ? pickerTitle[assignFlow] : ""}
        description={assignFlow ? pickerDescription[assignFlow] : undefined}
        confirmLabel={assignFlow ? pickerConfirm[assignFlow] : undefined}
        loading={busy}
        onClose={() => setAssignFlow(null)}
        onSelect={onPickerSelect}
      />

      <NotifyModal
        open={showNotify}
        invoice={invoice}
        onClose={() => setShowNotify(false)}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Page anchor — observes the column for the rendered PDF page element
// so the stamp overlay can position itself relative to actual page
// geometry. react-pdf's <Page> mounts asynchronously and re-mounts on
// scale/page changes, so we re-query whenever pdf state shifts.
// ──────────────────────────────────────────────────────────────────────────

function PageAnchor({
  columnRef,
  currentPage,
  invoiceUrl,
  onElement,
}: {
  columnRef: React.RefObject<HTMLDivElement | null>;
  currentPage: number;
  invoiceUrl: string | null;
  onElement: (el: HTMLElement | null) => void;
}) {
  // Re-find the page element whenever the PDF re-renders. We watch for
  // the data-pdf-page attribute that PdfViewer sets on the wrapper
  // around <Page>.
  useEffect(() => {
    const root = columnRef.current;
    if (!root) return;

    let raf = 0;
    const tick = () => {
      const el = root.querySelector<HTMLElement>(`[data-pdf-page="${currentPage}"]`);
      onElement(el);
    };
    // Initial probe
    tick();
    // Plus a couple of polls in case the canvas takes a few ms to mount
    raf = window.setTimeout(tick, 100) as unknown as number;
    const raf2 = window.setTimeout(tick, 400) as unknown as number;

    // And a MutationObserver to catch async swaps (page change, scale
    // change → react-pdf rebuilds the canvas)
    const obs = new MutationObserver(tick);
    obs.observe(root, { childList: true, subtree: true });

    return () => {
      window.clearTimeout(raf);
      window.clearTimeout(raf2);
      obs.disconnect();
    };
  }, [columnRef, currentPage, invoiceUrl, onElement]);

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Status banner — context-sensitive feedback above the two columns.
// ──────────────────────────────────────────────────────────────────────────

function StatusBanner({
  invoice,
  qbo,
  qboConnected,
  isAdmin,
  onReject,
  onReport,
  children,
}: {
  invoice: Invoice;
  qbo: QboStatus | undefined;
  qboConnected: boolean;
  isAdmin: boolean;
  onReject: () => void;
  onReport: () => void;
  children?: React.ReactNode;
}) {
  const base =
    "mb-4 p-4 border-l-2 flex items-start gap-3";
  if (invoice.status === "extraction_failed") {
    return (
      <div className={`${base} bg-red-50 border-red-700`}>
        <ExclamationTriangleIcon className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-red-900">Extraction failed</div>
          {invoice.extraction_error && (
            <div className="text-xs text-red-800 mt-1 font-mono break-all">
              {invoice.extraction_error}
            </div>
          )}
        </div>
        {children}
      </div>
    );
  }
  if (invoice.status === "approved" && invoice.qbo_post_error) {
    return (
      <div className={`${base} bg-amber/10 border-amber`}>
        <ExclamationTriangleIcon className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-navy">QBO posting failed</div>
          <div className="text-xs text-graphite mt-1 font-mono break-all">
            {invoice.qbo_post_error}
          </div>
        </div>
        {children}
      </div>
    );
  }
  if (invoice.status === "approved" && !qboConnected) {
    return (
      <div className={`${base} bg-amber/10 border-amber`}>
        <ClockIcon className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-navy">
          <strong>Approved.</strong> Connect QuickBooks to post, or click{" "}
          <em>Post to QBO</em> once connected.
        </div>
      </div>
    );
  }
  if (invoice.status === "approved" && qboConnected && qbo?.needs_expense_account) {
    return (
      <div className={`${base} bg-red-50 border-red-700`}>
        <ExclamationTriangleIcon className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-red-900">
          <strong>No default expense account set.</strong> Posting will fail
          until one is chosen.{" "}
          {isAdmin ? (
            <>
              Set it on the{" "}
              <Link
                to="/settings"
                search={{ qbo_connected: undefined, qbo_error: undefined }}
                className="underline font-semibold"
              >
                Settings
              </Link>{" "}
              page.
            </>
          ) : (
            <>Ask an admin to set one in Settings.</>
          )}
        </div>
        {children}
      </div>
    );
  }
  if (invoice.status === "approved" && qbo?.needs_reconnect) {
    return (
      <div className={`${base} bg-amber/10 border-amber`}>
        <ExclamationTriangleIcon className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-navy">
          <strong>QuickBooks needs reconnecting.</strong> The authorization has
          expired or is about to, so posting may fail.{" "}
          {isAdmin ? (
            <>
              Reconnect it on the{" "}
              <Link
                to="/settings"
                search={{ qbo_connected: undefined, qbo_error: undefined }}
                className="underline font-semibold"
              >
                Settings
              </Link>{" "}
              page.
            </>
          ) : (
            <>Ask an admin to reconnect it in Settings.</>
          )}
        </div>
        {children}
      </div>
    );
  }
  if (invoice.status === "posted_to_qbo") {
    const billUrl = qboBillUrl(qbo, invoice.qbo_bill_id);
    return (
      <div className={`${base} bg-green-50 border-green-700`}>
        <CheckCircleIcon className="h-5 w-5 text-green-700 flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-green-900">
          <strong>Posted to QBO</strong>
          {invoice.qbo_bill_id && <> as bill #{invoice.qbo_bill_id}</>}
          {invoice.qbo_posted_at && <> on {formatDate(invoice.qbo_posted_at)}</>}
          {invoice.reviewed_by_email && <> · reviewed by {invoice.reviewed_by_email}</>}.
          {billUrl && (
            <>
              {" "}
              <a
                href={billUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-semibold text-green-900 underline underline-offset-2 hover:text-green-700"
              >
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                View in QuickBooks
              </a>
            </>
          )}
        </div>
      </div>
    );
  }
  if (invoice.status === "rejected") {
    return (
      <div className={`${base} bg-red-50 border-red-700`}>
        <XCircleIcon className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm text-red-900">
          <strong>Rejected</strong>
          {invoice.reviewed_by_email && <> by {invoice.reviewed_by_email}</>}
          {invoice.reviewed_at && <> on {formatDate(invoice.reviewed_at)}</>}.
        </div>
      </div>
    );
  }
  if (invoice.status === "needs_triage") {
    return (
      <TriageBanner invoice={invoice} isAdmin={isAdmin} onReject={onReject} onReport={onReport} />
    );
  }
  return null;
}

/**
 * Banner shown at the top of the review page for invoices in
 * NEEDS_TRIAGE. Surfaces the reason + per-reason guidance and inlines
 * the same Promote / Trust+promote / Reject actions the queue's
 * TriageRow exposes — so AP can act without scrolling to the footer.
 */
function TriageBanner({
  invoice,
  isAdmin,
  onReject,
  onReport,
}: {
  invoice: Invoice;
  isAdmin: boolean;
  onReject: () => void;
  onReport: () => void;
}) {
  const promote = usePromoteFromTriage(invoice.id);
  const trustAndPromote = useTrustSenderAndPromote(invoice.id);

  const isUnknownSender = invoice.triage_reason === "unknown_sender";
  const canTrust = !!invoice.sender_email;
  const busy = promote.isPending || trustAndPromote.isPending;

  // Per-reason guidance text. Kept short — the badge already says what
  // the reason is; the prose tells the operator what to look for.
  const guidance: Record<NonNullable<Invoice["triage_reason"]>, string> = {
    non_invoice:
      "Claude classified this as something other than an invoice (statement, quote, order acknowledgement, receipt, or supporting document). If it's actually a real invoice, click Promote to send it to the main queue.",
    unknown_sender:
      "We don't recognise this sender yet. Check the From address against the vendor you expect. Click Trust sender + promote if it's a real vendor, or Report if it looks like a scam.",
    auth_failed:
      "This email failed the standard sender checks (SPF/DKIM/DMARC), which is a sign the From address may be forged. Confirm with the vendor by phone before promoting. Report if you didn't expect it.",
    body_rendered:
      "There was no PDF attachment — we rendered the email body as a fallback. Verify the totals and line items extracted correctly before promoting.",
    encrypted_pdf:
      "This PDF is password-protected so extraction was skipped. Ask the vendor to resend an unencrypted copy, or upload a decrypted version manually. Reject when no longer needed.",
    low_confidence:
      "Claude wasn't confident about its extraction. Review the fields, fix anything wrong, then promote when it looks right.",
  };
  const reasonText = invoice.triage_reason
    ? guidance[invoice.triage_reason]
    : "Pending decision.";

  return (
    <div className="mb-4 p-4 border-l-2 border-amber bg-amber/10 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-navy">Needs triage</span>
            {invoice.triage_reason && (
              <TriageReasonBadge reason={invoice.triage_reason} />
            )}
            {invoice.document_type && (
              <DocumentTypeBadge type={invoice.document_type} />
            )}
          </div>
          <p className="text-sm text-graphite">{reasonText}</p>
          {(trustAndPromote.error ?? promote.error) != null && (
            <p className="text-xs font-medium text-red-700">
              {((trustAndPromote.error ?? promote.error) as Error).message}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {isUnknownSender && canTrust && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => trustAndPromote.mutate()}
            loading={trustAndPromote.isPending}
            disabled={busy}
          >
            Trust sender + promote
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => promote.mutate()}
          loading={promote.isPending}
          disabled={busy}
        >
          Promote to review queue
        </Button>
        {isAdmin && (
          <>
            <Button variant="destructive" size="sm" onClick={onReject} disabled={busy}>
              Reject
            </Button>
            <Button variant="ghost" size="sm" onClick={onReport} disabled={busy}>
              Report as suspicious
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Read-only view — summary panel shown when the invoice is past review.
// ──────────────────────────────────────────────────────────────────────────

function ReadOnlyView({
  invoice,
  vendors,
  projects,
  onEdit,
  editBusy,
  canEdit,
}: {
  invoice: Invoice;
  vendors: Vendor[];
  projects: Project[];
  onEdit: () => void;
  editBusy: boolean;
  canEdit: boolean;
}) {
  const showEdit =
    canEdit &&
    invoice.status !== "posted_to_qbo" && invoice.status !== "rejected";
  return (
    <div className="space-y-4">
      {showEdit && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            onClick={onEdit}
            loading={editBusy}
            title={
              invoice.status === "approved"
                ? "Unapproves and reopens the form"
                : "Edit fields"
            }
          >
            <PencilSquareIcon className="h-4 w-4" />
            Edit
          </Button>
        </div>
      )}
      <InvoiceSummary invoice={invoice} vendors={vendors} projects={projects} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Action footer — split-button layout. Primary action depends on status.
// ──────────────────────────────────────────────────────────────────────────

interface FooterProps {
  invoice: Invoice;
  dirty: boolean;
  busy: boolean;
  qboConnected: boolean;
  forceEdit: boolean;
  showEditor: boolean;
  /** Tracks the full QBO post roundtrip, not just the HTTP request. */
  postingInFlight: boolean;
  onSave: () => void;
  onCancelEdit: () => void;
  onReject: () => void;
  onReport: () => void;
  onApprove: () => void;
  onApproveAndPost: () => void;
  onAssign: () => void;
  onPost: () => void;
  onUnapprove: () => void;
  onClaim: () => void;
  patchPending: boolean;
  isAdmin: boolean;
  isAssignee: boolean;
  isClaimed: boolean;
}

function ActionFooter(props: FooterProps) {
  const {
    invoice,
    dirty,
    busy,
    qboConnected,
    forceEdit,
    showEditor,
    postingInFlight,
    onSave,
    onCancelEdit,
    onReject,
    onReport,
    onApprove,
    onApproveAndPost,
    onAssign,
    onPost,
    onUnapprove,
    onClaim,
    patchPending,
    isAdmin,
    isAssignee,
    isClaimed,
  } = props;

  // Admins act on any invoice. Members must be the assignee AND have claimed
  // it; an unclaimed assignee's only move is to claim it first.
  const canAct = isAdmin || (isAssignee && isClaimed);
  const mustClaim = !isAdmin && isAssignee && !isClaimed;

  const approveOption: SplitButtonOption = {
    label: "Approve",
    description: "Mark reviewed — doesn't post to QBO",
    onSelect: onApprove,
    icon: <CheckCircleIcon className="h-4 w-4" />,
  };
  const approveAndPostOption: SplitButtonOption = {
    label: "Approve & Post to QBO",
    description: qboConnected
      ? "Sends to QuickBooks immediately"
      : "Connect QuickBooks in Settings first",
    onSelect: onApproveAndPost,
    disabled: !qboConnected,
    icon: <PaperAirplaneIcon className="h-4 w-4" />,
  };
  const assignOption: SplitButtonOption = {
    label: invoice.assigned_to_id ? "Reassign…" : "Assign to teammate…",
    description: "Hand off to a team member to review",
    onSelect: onAssign,
    icon: <UserPlusIcon className="h-4 w-4" />,
  };

  // Pick the primary action based on status + role:
  //   - The assignee reviewing their own invoice → Approve is the headline.
  //   - An admin looking at an unassigned / someone-else's invoice → Assign by
  //     default (delegate), with Approve tucked into the dropdown.
  let primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    disabledReason?: string;
    variant?: "primary" | "secondary";
  };
  let options: SplitButtonOption[] = [];

  if (invoice.status === "ready_for_review" || invoice.status === "extraction_failed") {
    if (mustClaim) {
      primary = { label: "Claim to review", onClick: onClaim };
      options = [];
    } else if (isAssignee && canAct) {
      primary = { label: "Approve", onClick: onApprove };
      // PMs approve but don't post — an admin posts from the Ready-to-Post
      // queue. Only admins see the post shortcut here.
      options = isAdmin ? [approveAndPostOption, assignOption] : [];
    } else if (isAdmin) {
      primary = {
        label: invoice.assigned_to_id ? "Reassign" : "Assign",
        onClick: onAssign,
      };
      options = [approveOption, approveAndPostOption];
    } else {
      // A member who isn't the assignee has nothing to do here.
      return null;
    }
  } else if (invoice.status === "approved") {
    if (!canAct) {
      return null;
    }
    const unapproveOption: SplitButtonOption = {
      label: "Unapprove",
      description: "Revert to Needs Review for more edits",
      onSelect: onUnapprove,
      icon: <ArrowUturnLeftIcon className="h-4 w-4" />,
    };
    if (isAdmin) {
      primary = {
        label: "Post to QBO",
        onClick: onPost,
        disabled: !qboConnected,
        disabledReason: "Connect QuickBooks in Settings first",
      };
      options = [unapproveOption];
    } else {
      // PMs don't post; posting is an admin action from the Ready-to-Post
      // queue. Leave the assignee able to unapprove to fix a mistake.
      primary = {
        label: "Unapprove",
        onClick: onUnapprove,
        variant: "secondary",
      };
      options = [];
    }
  } else {
    // posted_to_qbo / rejected — no footer shown
    return null;
  }

  // Reject is available to anyone who can act — but not while just claiming.
  const rejectVisible = canAct;

  // When forceEdit is on for an already-approved invoice, show an edit-mode
  // footer instead — "Save and re-approve" etc.
  const isReapproving = forceEdit && invoice.status === "approved";

  // Inject Reject + Save draft + Cancel into the SplitButton dropdown so on
  // mobile a single full-width primary button is the only main control.
  // Desktop still surfaces them inline.
  const mobileExtraOptions: SplitButtonOption[] = [];
  if (showEditor && canAct) {
    mobileExtraOptions.push({
      label: dirty ? "Save draft" : "Saved",
      description: dirty
        ? "Persist edits without changing status"
        : "All changes already saved",
      onSelect: onSave,
      disabled: !dirty || patchPending,
      icon: <PencilSquareIcon className="h-4 w-4" />,
    });
  }
  if (rejectVisible) {
    mobileExtraOptions.push({
      label: "Reject",
      description: "Mark as rejected — captured in the audit log",
      onSelect: onReject,
      icon: <XCircleIcon className="h-4 w-4" />,
    });
    mobileExtraOptions.push({
      label: "Report as suspicious",
      description: "Reject and send the details to RelentNet",
      onSelect: onReport,
      icon: <ExclamationTriangleIcon className="h-4 w-4" />,
    });
  }
  if (isReapproving) {
    mobileExtraOptions.push({
      label: "Cancel edits",
      description: "Discard changes and return to read-only",
      onSelect: onCancelEdit,
      icon: <ArrowUturnLeftIcon className="h-4 w-4" />,
    });
  }
  const mobileOptions: SplitButtonOption[] =
    mobileExtraOptions.length === 0
      ? options
      : [
          ...options,
          { divider: true, label: "", onSelect: () => {} },
          ...mobileExtraOptions,
        ];

  return (
    <div className="sticky bottom-0 mt-6 md:mt-8 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 py-3 md:py-4 bg-stone border-t-2 border-navy z-20">
      {/* Status indicator */}
      <div className="text-xs text-slate-600 mb-2 sm:mb-0 sm:flex sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2">
          {showEditor ? (
            dirty ? (
              <>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber" />
                <span>Unsaved edits</span>
              </>
            ) : (
              <span>All changes saved.</span>
            )
          ) : (
            <span>
              Status:{" "}
              <span className="text-graphite font-medium">
                {invoice.status.replace(/_/g, " ")}
              </span>
            </span>
          )}
        </div>

        {/* Desktop button row — appears inline at sm+; mobile gets a single
            full-width SplitButton below. items-stretch keeps every control the
            same height despite their different styles (the bordered "secondary"
            is otherwise a touch taller). */}
        <div className="hidden sm:flex items-stretch gap-2 flex-wrap sm:flex-nowrap">
          {isReapproving && (
            <Button variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
          )}
          {rejectVisible && (
            <>
              <Button variant="ghost" onClick={onReport} title="Reject and send to RelentNet">
                Report
              </Button>
              <Button
                variant="destructive"
                onClick={onReject}
                title="Reject (⌘+Shift+R)"
              >
                Reject
              </Button>
            </>
          )}
          {showEditor && canAct && (
            <Button
              variant="secondary"
              onClick={onSave}
              disabled={!dirty}
              loading={patchPending}
            >
              Save draft
            </Button>
          )}
          <SplitButton
            primaryLabel={
              postingInFlight && primary.label === "Post to QBO"
                ? "Posting to QBO…"
                : primary.label
            }
            onPrimary={primary.onClick}
            options={options}
            variant="primary"
            disabled={primary.disabled || busy || postingInFlight}
            title={primary.disabled ? primary.disabledReason : undefined}
            loading={(busy && !patchPending) || postingInFlight}
          />
        </div>
      </div>

      {/* Mobile: a single full-width SplitButton with secondary actions
          folded into the dropdown. */}
      <div className="sm:hidden">
        <SplitButton
          className="w-full"
          primaryLabel={
            postingInFlight && primary.label === "Post to QBO"
              ? "Posting to QBO…"
              : primary.label
          }
          onPrimary={primary.onClick}
          options={mobileOptions}
          variant="primary"
          disabled={primary.disabled || busy || postingInFlight}
          title={primary.disabled ? primary.disabledReason : undefined}
          loading={(busy && !patchPending) || postingInFlight}
        />
      </div>
    </div>
  );
}
