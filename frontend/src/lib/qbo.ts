/**
 * QuickBooks Online hooks. Filled in by phase 7.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import type { QboStatus } from "@/types";

export function useQboStatus() {
  const { request } = useApi();
  return useQuery({
    queryKey: qk.qbo.status(),
    queryFn: () => request<QboStatus>("/api/qbo/status"),
    staleTime: 30_000,
  });
}

export function useConnectQbo() {
  const { request } = useApi();
  return useMutation({
    mutationFn: async () => {
      const { url } = await request<{ url: string }>("/api/qbo/connect");
      window.location.href = url;
    },
  });
}

export function useDisconnectQbo() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("/api/qbo/disconnect", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.qbo.status() });
    },
  });
}

export function useSyncVendors() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ count: number }>("/api/qbo/sync/vendors", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.vendors.root() });
      void qc.invalidateQueries({ queryKey: qk.qbo.status() });
    },
  });
}

export function useSyncProjects() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ count: number }>("/api/qbo/sync/projects", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.projects.root() });
      void qc.invalidateQueries({ queryKey: qk.qbo.status() });
    },
  });
}

export function useSyncItems() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request<{ items: number; mapped: number; unmapped: number }>("/api/qbo/sync/items", {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.codingOptions.root() });
    },
  });
}

export interface QboItem {
  id: string;
  name: string;
  fully_qualified_name: string;
}

/** Active QBO Products/Services, for mapping cost codes on Settings. */
export function useQboItems(enabled = true) {
  const { request } = useApi();
  return useQuery({
    queryKey: [...qk.qbo.root(), "items"],
    queryFn: () => request<{ items: QboItem[] }>("/api/qbo/items"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export interface QboExpenseAccount {
  id: string;
  name: string;
  account_type: string | null;
  account_sub_type: string | null;
}

export function useExpenseAccounts(enabled = true) {
  const { request } = useApi();
  return useQuery({
    queryKey: [...qk.qbo.root(), "expense-accounts"],
    queryFn: () => request<{ accounts: QboExpenseAccount[] }>("/api/qbo/expense-accounts"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export interface QboSettingsPatch {
  project_source?: "Customer" | "Class";
  default_expense_account_id?: string | null;
}

export function useUpdateQboSettings() {
  const { request } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: QboSettingsPatch) =>
      request<{ status: string }>("/api/qbo/settings", {
        method: "PATCH",
        body: patch as unknown as BodyInit,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.qbo.status() });
    },
  });
}
