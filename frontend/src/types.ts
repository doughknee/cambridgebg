export type InvoiceStatus =
  | "received"
  | "extracting"
  | "extraction_failed"
  | "ready_for_review"
  | "needs_triage"
  | "approved"
  | "posted_to_qbo"
  | "rejected";

export type DocumentType =
  | "invoice"
  | "statement"
  | "quote"
  | "order_ack"
  | "receipt"
  | "supporting_doc"
  | "other"
  | "unknown";

export type TriageReason =
  | "non_invoice"
  | "unknown_sender"
  | "body_rendered"
  | "encrypted_pdf"
  | "low_confidence"
  | "auth_failed";

export interface LineItem {
  description: string;
  quantity: number | null;
  unit_price_cents: number | null;
  amount_cents: number | null;
}

export interface Invoice {
  id: string;
  created_at: string;
  updated_at: string;
  source: "email" | "upload";
  sender_email: string | null;
  email_subject: string | null;
  email_body: string | null;
  /** "spf=pass dkim=pass dmarc=fail"; null when the provider sent nothing. */
  email_auth: string | null;
  /** Sender is in the trusted allowlist. Only populated on GET detail. */
  sender_trusted?: boolean | null;
  received_at: string;
  pdf_filename: string;
  pdf_size_bytes: number;
  pdf_page_count: number | null;
  pdf_url?: string | null;
  status: InvoiceStatus;
  extraction_error: string | null;
  vendor_name: string | null;
  vendor_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  currency: string;
  po_number: string | null;
  notes: string | null;
  line_items: LineItem[];
  project_id: string | null;

  // Cambridge AP coding markup (added by AP team to the PDF)
  job_number: string | null;
  cost_code: string | null;
  coding_date: string | null;
  approver: string | null;
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  qbo_bill_id: string | null;
  qbo_posted_at: string | null;
  qbo_post_error: string | null;
  assigned_to_id: string | null;
  assigned_to_email: string | null;
  assigned_to_name: string | null;
  assigned_at: string | null;
  claimed_at: string | null;

  /** Per-invoice override for where the AP stamp lands on the QBO
   *  attachment. All values are fractions of the page (top-anchored).
   *  Null = use default top-right placement. */
  stamp_position: StampPosition | null;

  /** Set by the extractor — what kind of document this is. Drives
   *  the routing decision between READY_FOR_REVIEW and NEEDS_TRIAGE. */
  document_type: DocumentType | null;
  /** When status === "needs_triage", explains why we routed it there. */
  triage_reason: TriageReason | null;
}

export interface TrustedDomain {
  id: string;
  domain: string;
  source: "qbo_sync" | "manual" | "promoted_from_triage";
  qbo_vendor_id: string | null;
  added_by_id: string | null;
  added_by_email: string | null;
  notes: string | null;
  created_at: string;
}

export interface TrustedDomainListResponse {
  domains: TrustedDomain[];
  counts: Record<string, number>;
}

export interface StampPosition {
  /** Distance from page LEFT edge to stamp's left edge, as a fraction
   *  of page width (0–1). */
  x: number;
  /** Distance from page TOP edge to stamp's top edge, as a fraction of
   *  page height (0–1). */
  y: number;
  /** Stamp width as a fraction of page width. */
  width: number;
  /** Stamp height as a fraction of page height. Optional for backward
   *  compatibility — when missing, the backend falls back to deriving
   *  height from the natural ~2.29:1 aspect ratio. */
  height?: number;
}

export interface InvoiceListResponse {
  invoices: Invoice[];
  total: number;
  page: number;
  page_size: number;
}

export interface Vendor {
  id: string;
  qbo_id: string | null;
  display_name: string;
  email: string | null;
  active: boolean;
  last_synced_at: string | null;
}

export interface Project {
  id: string;
  qbo_id: string;
  qbo_type: "Customer" | "Class";
  display_name: string;
  parent_qbo_id: string | null;
  active: boolean;
  last_synced_at: string | null;
}

export interface AuditLogEntry {
  id: string;
  created_at: string;
  actor_id: string;
  actor_email: string | null;
  invoice_id: string | null;
  invoice_vendor_name: string | null;
  invoice_number: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  message: string | null;
}

export interface QboStatus {
  connected: boolean;
  environment: "sandbox" | "production";
  realm_id: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  /** Refresh token is expired or close to it — prompt the user to reconnect. */
  needs_reconnect: boolean;
  /** No default expense account set (saved or via env) — posting will fail. */
  needs_expense_account: boolean;
  last_vendor_sync_at: string | null;
  last_project_sync_at: string | null;
  project_source: "Customer" | "Class";
  default_expense_account_id: string | null;
}

export interface CurrentUser {
  id: string;
  email: string | null;
  name: string | null;
}

export type AccessRequestStatus = "pending" | "approved" | "dismissed";

export interface AccessRequest {
  id: string;
  created_at: string;
  updated_at: string;
  email: string;
  name: string | null;
  message: string | null;
  status: AccessRequestStatus;
  handled_by_id: string | null;
  handled_by_email: string | null;
  handled_at: string | null;
}

export interface AccessRequestListResponse {
  requests: AccessRequest[];
  pending_count: number;
}

// AP coding dropdown options (admin-managed)
export type CodingField = "job_number" | "cost_code" | "approver";

export interface CodingOption {
  id: string;
  created_at: string;
  updated_at: string;
  field: CodingField;
  value: string;
  label: string | null;
  active: boolean;
}

export interface CodingOptionListResponse {
  options: CodingOption[];
}
