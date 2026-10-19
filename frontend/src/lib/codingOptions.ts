/**
 * Hooks + helpers for the admin-managed AP coding dropdowns.
 *
 * Read is open to any auth user (so PMs see the dropdowns); writes are
 * gated server-side on admin+. The frontend doesn't double-gate — it
 * just lets the 403 surface naturally if a member tries to mutate.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { CodingField, CodingOption, CodingOptionListResponse } from "@/types";

export function useCodingOptions() {
  const { request } = useApi();
  return useQuery({
    queryKey: qk.codingOptions.list(),
    queryFn: () => request<CodingOptionListResponse>("/api/coding-options"),
    staleTime: 60_000,
  });
}

/**
 * Group options by field. Returns a Map so callers can
 * `groups.get('job_number') ?? []`.
 */
export function groupByField(options: CodingOption[] | undefined) {
  const map: Record<CodingField, CodingOption[]> = {
    job_number: [],
    cost_code: [],
    approver: [],
  };
  for (const o of options ?? []) {
    if (o.active) map[o.field].push(o);
  }
  return map;
}

export interface CreateCodingOptionPayload {
  field: CodingField;
  value: string;
  label?: string | null;
}

export function useCreateCodingOption() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCodingOptionPayload) =>
      request<CodingOption>("/api/coding-options", {
        method: "POST",
        body: payload as unknown as BodyInit,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.codingOptions.root() });
    },
  });
}

export interface PatchCodingOptionPayload {
  value?: string;
  label?: string | null;
  active?: boolean;
  qbo_item_id?: string | null;
  qbo_item_name?: string | null;
}

export function usePatchCodingOption() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchCodingOptionPayload }) =>
      request<CodingOption>(`/api/coding-options/${id}`, {
        method: "PATCH",
        body: patch as unknown as BodyInit,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.codingOptions.root() });
    },
  });
}

export function useDeleteCodingOption() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<void>(`/api/coding-options/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.codingOptions.root() });
    },
  });
}

export const FIELD_LABELS: Record<CodingField, string> = {
  job_number: "Job number",
  cost_code: "Cost code",
  approver: "Approver",
};
