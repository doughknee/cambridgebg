/**
 * Invoice-specific API calls and React Query hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type {
  Invoice,
  InvoiceListResponse,
  InvoiceStatus,
  LineItem,
  Project,
  Vendor,
} from "@/types";

export interface ListParams {
  status?: InvoiceStatus[];
  /**
   * Server-side assignment filter:
   * - "true"  → only invoices that have an assignee
   * - "false" → only unassigned invoices
   * - "mine"  → assigned specifically to the current user
   */
  assigned?: "true" | "false" | "mine";
  q?: string;
  /** Filter by Cambridge job number (case-insensitive substring match). */
  job?: string;
  page?: number;
  page_size?: number;
}

function toQuery(params: ListParams): string {
  const sp = new URLSearchParams();
  if (params.status) {
    for (const s of params.status) sp.append("status", s);
  }
  if (params.assigned) sp.set("assigned", params.assigned);
  if (params.q) sp.set("q", params.q);
  if (params.job) sp.set("job", params.job);
  if (params.page) sp.set("page", String(params.page));
  if (params.page_size) sp.set("page_size", String(params.page_size));
  return sp.toString();
}

export function useInvoices(params: ListParams) {
  const { request } = useApi();
  return useQuery({
    queryKey: qk.invoices.list(params),
    queryFn: () => {
      const query = toQuery(params);
      return request<InvoiceListResponse>(`/api/invoices${query ? `?${query}` : ""}`);
    },
    refetchInterval: 10_000, // poll for new inbound invoices / extraction progress
  });
}

export function useInvoice(id: string | undefined, opts?: { burstPoll?: boolean }) {
  const { request } = useApi();
  return useQuery({
    queryKey: id ? qk.invoices.detail(id) : ["disabled"],
    queryFn: () => request<Invoice>(`/api/invoices/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data as Invoice | undefined;
      if (!data) return false;
      // Poll while extraction is in flight.
      if (data.status === "extracting" || data.status === "received") return 2000;
      // Poll while a post-to-QBO is pending (approved, no bill id, no error yet).
      if (
        opts?.burstPoll &&
        data.status === "approved" &&
        !data.qbo_bill_id &&
        !data.qbo_post_error
      ) {
        return 1500;
      }
      return false;
    },
  });
}

export function useUploadInvoice() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return request<Invoice>("/api/invoices", {
        method: "POST",
        formData: fd,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export interface InvoicePatchPayload {
  vendor_name?: string | null;
  vendor_id?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  subtotal_cents?: number | null;
  tax_cents?: number | null;
  total_cents?: number | null;
  currency?: string;
  po_number?: string | null;
  notes?: string | null;
  line_items?: LineItem[];
  project_id?: string | null;
  // Cambridge AP coding markup
  job_number?: string | null;
  cost_code?: string | null;
  coding_date?: string | null;
  approver?: string | null;
  stamp_position?: { x: number; y: number; width: number; height?: number } | null;
}

export function usePatchInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: InvoicePatchPayload) =>
      request<Invoice>(`/api/invoices/${id}`, {
        method: "PATCH",
        body: patch as unknown as BodyInit,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useApproveInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request<Invoice>(`/api/invoices/${id}/approve`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useApproveAndPostInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request<Invoice>(`/api/invoices/${id}/approve-and-post`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function usePostInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/post`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useUnapproveInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/unapprove`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export interface AssignPayload {
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
  /** Email the new assignee. Defaults true server-side; send false to assign quietly. */
  notify?: boolean;
}

export function useAssignInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AssignPayload) =>
      request<Invoice>(`/api/invoices/${id}/assign`, {
        method: "POST",
        body: payload as unknown as BodyInit,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

/**
 * The assignee claims an invoice — signals to admins that they've opened it
 * and taken ownership. Idempotent on the backend.
 */
export function useClaimInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/claim`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useUnassignInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/unassign`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useRejectInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      request<Invoice>(`/api/invoices/${id}/reject`, {
        method: "POST",
        body: { reason } as unknown as BodyInit,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useReextractInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/reextract`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
    },
  });
}

export function useRetryQbo(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/retry-qbo`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
    },
  });
}

/**
 * Move an invoice from NEEDS_TRIAGE → READY_FOR_REVIEW. Used by the
 * triage row's "Promote" action and also by the review screen banner
 * when AP confirms a triaged document is actually a real invoice.
 */
export function usePromoteFromTriage(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/promote`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      // Triage list shrinks; main queue may grow.
      qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

/**
 * Trust the sender's email domain + promote in one click. Called from
 * the triage row when ``triage_reason === 'unknown_sender'`` (or any
 * time the operator wants to mark this vendor as known going forward).
 */
/**
 * Reject as suspicious and forward the details to RelentNet. Same
 * permission rule as reject (admin or assignee).
 */
export function useReportInvoice(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Invoice>(`/api/invoices/${id}/report`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      void qc.invalidateQueries({ queryKey: qk.invoices.root() });
    },
  });
}

export function useTrustSenderAndPromote(id: string) {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request<Invoice>(`/api/invoices/${id}/trust-sender`, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(qk.invoices.detail(id), data);
      qc.invalidateQueries({ queryKey: qk.invoices.root() });
      // Trusted-domains list also gains a new entry.
      qc.invalidateQueries({ queryKey: ["trusted-domains"] });
    },
  });
}

export function useVendors() {
  const { request } = useApi();
  return useQuery({
    queryKey: qk.vendors.list(),
    queryFn: () => request<{ vendors: Vendor[] }>("/api/vendors"),
    staleTime: 60_000,
  });
}

export function useProjects() {
  const { request } = useApi();
  return useQuery({
    queryKey: qk.projects.list(),
    queryFn: () => request<{ projects: Project[] }>("/api/projects"),
    staleTime: 60_000,
  });
}
