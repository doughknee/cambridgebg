import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/solid";
import {
  ArrowPathIcon,
  BellIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  UserCircleIcon,
  TagIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { PageHeader, SectionLabel } from "@/components/layout/AppShell";
import { useMobileAppBar } from "@/components/layout/MobileAppBar";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  useConnectQbo,
  useDisconnectQbo,
  useExpenseAccounts,
  useQboStatus,
  useSyncProjects,
  useSyncVendors,
  useUpdateQboSettings,
} from "@/lib/qbo";
import {
  FIELD_LABELS,
  groupByField,
  useCodingOptions,
  useCreateCodingOption,
  useDeleteCodingOption,
  usePatchCodingOption,
} from "@/lib/codingOptions";
import {
  useAddTrustedDomain,
  useRemoveTrustedDomain,
  useTrustedDomains,
} from "@/lib/trustedDomains";
import {
  useMyNotificationPrefs,
  useNotificationSettings,
  useRunDigestNow,
  useUpdateMyNotificationPrefs,
  useUpdateNotificationSettings,
} from "@/lib/notifications";
import {
  useMe,
  useMyMfa,
  useRemoveMyMfa,
  useSetMyPassword,
  useUpdateMyName,
  ROLE_RANK,
  type MfaFactor,
} from "@/lib/users";
import {
  passwordPolicy,
  PolicyItem,
  POLICY_RULES,
} from "@/components/auth/PasswordSetupModal";
import type {
  CodingField,
  CodingOption,
  TrustedDomain,
} from "@/types";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    qbo_connected: search.qbo_connected as string | undefined,
    qbo_error: search.qbo_error as string | undefined,
  }),
});

function SettingsPage() {
  useMobileAppBar({ title: "Settings" });
  const search = useSearch({ from: "/_authed/settings" });
  const qboQuery = useQboStatus();
  const accountsQuery = useExpenseAccounts(qboQuery.data?.connected ?? false);
  const connect = useConnectQbo();
  const disconnect = useDisconnectQbo();
  const syncVendors = useSyncVendors();
  const syncProjects = useSyncProjects();
  const updateSettings = useUpdateQboSettings();
  const navigate = useNavigate();

  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (search.qbo_connected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surface the QBO redirect result as a banner
      setBanner({ kind: "ok", text: "Connected to QuickBooks Online." });
    } else if (search.qbo_error) {
      setBanner({ kind: "err", text: `QBO connection failed: ${search.qbo_error}` });
    }
  }, [search.qbo_connected, search.qbo_error]);

  const qbo = qboQuery.data;
  const connected = qbo?.connected ?? false;

  return (
    <>
      <PageHeader
        title="Portal"
        accent="Settings"
        subtitle="Connect accounting and tune extraction defaults."
      />

      {banner && (
        <div
          className={
            banner.kind === "ok"
              ? "mb-4 p-3 border-l-2 border-green-700 bg-green-50 text-sm text-green-900"
              : "mb-4 p-3 border-l-2 border-red-700 bg-red-50 text-sm text-red-900"
          }
        >
          {banner.text}
        </div>
      )}

      <div className="space-y-6">
        {/* The signed-in user's own account — everyone sees this. */}
        <AccountSection />

        {/* QBO Connection */}
        <Card accent="top" id="quickbooks" className="scroll-mt-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-2xl text-navy flex items-center gap-2">
                  <LinkIcon className="h-5 w-5 text-amber" aria-hidden />
                  QuickBooks Online
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Post approved bills and sync vendors + projects.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {qboQuery.error ? (
                  // Don't claim "Not connected" when we couldn't even ask —
                  // e.g. an auth failure. The connection may be fine.
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500">
                    <ExclamationTriangleIcon className="h-5 w-5" />
                    Status unavailable
                  </span>
                ) : connected ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-800">
                    <CheckCircleIcon className="h-5 w-5" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500">
                    <XCircleIcon className="h-5 w-5" />
                    Not connected
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {qboQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {qboQuery.error && (
              <p className="text-sm text-red-700">
                {(qboQuery.error as Error).message}
              </p>
            )}
            {qbo && (
              <>
                {connected ? (
                  <div className="space-y-3">
                    {qbo.needs_reconnect && (
                      <div className="flex items-start gap-2 border-l-2 border-amber bg-amber/10 px-3 py-2 text-sm text-navy">
                        <ExclamationTriangleIcon className="h-5 w-5 text-amber flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-semibold">
                            Reconnect QuickBooks soon
                          </p>
                          <p className="text-xs text-graphite mt-0.5">
                            The QuickBooks authorization has expired or is about
                            to. Posting bills will fail until you reconnect.
                          </p>
                          <Button
                            variant="primary"
                            size="sm"
                            className="mt-2"
                            onClick={() => connect.mutate()}
                            loading={connect.isPending}
                          >
                            Reconnect now
                          </Button>
                        </div>
                      </div>
                    )}
                    {qbo.needs_expense_account && (
                      <div className="flex items-start gap-2 border-l-2 border-red-700 bg-red-50 px-3 py-2 text-sm text-red-900">
                        <ExclamationTriangleIcon className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-semibold">
                            Set a default expense account
                          </p>
                          <p className="text-xs text-red-800 mt-0.5">
                            Posting bills will fail until one is set. Choose it
                            under <em>Sync settings → Default expense account</em>{" "}
                            below.
                          </p>
                        </div>
                      </div>
                    )}
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <Field label="Realm ID" value={qbo.realm_id ?? "—"} mono />
                      <Field
                        label="Access token expires"
                        value={formatDateTime(qbo.expires_at)}
                      />
                      <Field
                        label="Refresh token expires"
                        value={formatDateTime(qbo.refresh_expires_at)}
                      />
                      <Field
                        label="Last vendor sync"
                        value={formatDateTime(qbo.last_vendor_sync_at)}
                      />
                      <Field
                        label="Last project sync"
                        value={formatDateTime(qbo.last_project_sync_at)}
                      />
                    </dl>
                    <div className="flex flex-wrap gap-2 pt-3 border-t border-stone/80">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => syncVendors.mutate()}
                        loading={syncVendors.isPending}
                      >
                        <ArrowPathIcon className="h-4 w-4" />
                        Sync vendors{" "}
                        {syncVendors.data && `(${syncVendors.data.count})`}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => syncProjects.mutate()}
                        loading={syncProjects.isPending}
                      >
                        <ArrowPathIcon className="h-4 w-4" />
                        Sync projects{" "}
                        {syncProjects.data && `(${syncProjects.data.count})`}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => navigate({ to: "/quickbooks" })}
                      >
                        Vendors &amp; projects →
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => disconnect.mutate()}
                        loading={disconnect.isPending}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => connect.mutate()}
                    loading={connect.isPending}
                  >
                    Connect to QuickBooks Online
                  </Button>
                )}
              </>
            )}
          </CardBody>
        </Card>

        {/* Sync settings */}
        {connected && (
          <Card accent="left" id="sync" className="scroll-mt-6">
            <CardHeader>
              <h2 className="font-display text-2xl text-navy flex items-center gap-2">
                <ArrowPathIcon className="h-5 w-5 text-amber" aria-hidden />
                Sync settings
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                How projects and expense accounts map when posting to QuickBooks.
              </p>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label="Project source"
                  value={qbo?.project_source ?? "Customer"}
                  onChange={(e) =>
                    updateSettings.mutate({
                      project_source: e.target.value as "Customer" | "Class",
                    })
                  }
                  hint="Where project tags come from."
                >
                  <option value="Customer">Customers (with sub-customers)</option>
                  <option value="Class">Classes</option>
                </Select>

                <Select
                  label="Default expense account"
                  value={qbo?.default_expense_account_id ?? ""}
                  onChange={(e) =>
                    updateSettings.mutate({
                      default_expense_account_id: e.target.value || null,
                    })
                  }
                  hint="Used when posting bills with line items that have no account set."
                  disabled={accountsQuery.isLoading}
                  // Without this a failed fetch looks identical to "this company
                  // has no expense accounts" — both render a lone "— not set —".
                  error={
                    accountsQuery.isError
                      ? "Couldn't load accounts from QuickBooks. Try Sync, or check the backend logs."
                      : !accountsQuery.isLoading && accountsQuery.data?.accounts.length === 0
                        ? "QuickBooks returned no accounts for this company."
                        : undefined
                  }
                >
                  <option value="">— not set —</option>
                  {accountsQuery.data?.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.account_type ? ` (${a.account_type})` : ""}
                    </option>
                  ))}
                </Select>
              </div>
            </CardBody>
          </Card>
        )}

        {/* AP coding options — admin/owner only. PMs see the dropdowns
            on the review screen; this is where the curated list lives. */}
        <APCodingSection />

        {/* Email-domain allowlist used by the triage workflow.
            Auto-populated from QBO vendor emails on every sync;
            admins can add manual entries for partners not in QBO. */}
        <TrustedDomainsSection />

        {/* Each user's own opt-in/out for the emails they receive. Everyone. */}
        <MyNotificationsSection />

        {/* Daily review digest + send-time config. Admin/owner only. */}
        <NotificationsSection />
      </div>
    </>
  );
}

const TZ_OPTIONS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "UTC",
];

// ──────────────────────────────────────────────────────────────────────────
// Account — the signed-in user's own profile: display name + password.
// Email is read-only (changing it would need a verification flow in Logto).
// ──────────────────────────────────────────────────────────────────────────

function AccountSection() {
  const me = useMe();
  const updateName = useUpdateMyName();
  const setPassword = useSetMyPassword();

  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwSaved, setPwSaved] = useState(false);

  useEffect(() => {
    if (me.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate form from fetched profile
      setName(me.data.name ?? "");
    }
  }, [me.data]);

  const { lengthOk, classesOk } = passwordPolicy(next);
  const mismatch = confirm.length > 0 && next !== confirm;
  const nameDirty =
    !!me.data && name.trim().length > 0 && name.trim() !== (me.data.name ?? "");
  const canChangePw =
    lengthOk && classesOk && next === confirm && current.length > 0 && !setPassword.isPending;

  function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!canChangePw) return;
    setPwSaved(false);
    setPassword.mutate(
      { password: next, current_password: current },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setConfirm("");
          setPwSaved(true);
        },
      },
    );
  }

  return (
    <Card accent="top" id="account" className="scroll-mt-6">
      <CardHeader>
        <h2 className="font-display text-2xl text-navy flex items-center gap-2">
          <UserCircleIcon className="h-5 w-5 text-amber" aria-hidden />
          Account
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Your profile and sign-in details.
        </p>
      </CardHeader>
      <CardBody>
        {me.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-6">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Field label="Email" value={me.data?.email ?? "—"} mono />
              <Field label="Role" value={me.data?.role ?? "member"} />
            </dl>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[220px]">
                <Input
                  label="Display name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="How your name appears to teammates"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateName.mutate(name.trim())}
                loading={updateName.isPending}
                disabled={!nameDirty}
              >
                Save
              </Button>
            </div>
            {updateName.error && (
              <p className="text-sm text-red-700">
                {(updateName.error as Error).message}
              </p>
            )}

            <form onSubmit={changePassword} className="space-y-3 pt-4 border-t border-stone/60">
              <SectionLabel>
                <span className="inline-flex items-center gap-1.5">
                  <KeyIcon className="h-3.5 w-3.5 text-amber" aria-hidden />
                  Change password
                </span>
              </SectionLabel>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input
                  label="Current password"
                  labelTone="quiet"
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                />
                <Input
                  label="New password"
                  labelTone="quiet"
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  autoComplete="new-password"
                />
                <Input
                  label="Confirm new password"
                  labelTone="quiet"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  error={mismatch ? "Passwords don't match" : undefined}
                />
              </div>
              {next.length > 0 && (
                <ul className="text-xs space-y-1 border-l-2 border-slate-200 pl-3">
                  <PolicyItem ok={lengthOk}>{POLICY_RULES[0]}</PolicyItem>
                  <PolicyItem ok={classesOk}>{POLICY_RULES[1]}</PolicyItem>
                </ul>
              )}
              {setPassword.error && (
                <p className="text-sm text-red-700 bg-red-50 border-l-2 border-red-700 px-3 py-2">
                  {(setPassword.error as Error).message}
                </p>
              )}
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={setPassword.isPending}
                  disabled={!canChangePw}
                >
                  Update password
                </Button>
                {pwSaved && (
                  <span className="text-xs text-green-800">Password updated.</span>
                )}
              </div>
            </form>

            <MfaList />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const MFA_TYPE_LABEL: Record<string, string> = {
  WebAuthn: "Passkey",
  Totp: "Authenticator app",
  BackupCode: "Backup codes",
};

// Passkeys are device-bound (a Windows Hello passkey doesn't exist on your
// phone), so a stuck factor must be removable without the Logto console.
function MfaList() {
  const mfa = useMyMfa();
  const remove = useRemoveMyMfa();
  const factors = mfa.data?.factors ?? [];

  return (
    <div className="space-y-3 pt-4 border-t border-stone/60">
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheckIcon className="h-3.5 w-3.5 text-amber" aria-hidden />
          Passkeys &amp; two-factor
        </span>
      </SectionLabel>
      <p className="text-xs text-slate-500">
        A passkey only works on the device it was created on. If one is
        locking you out on another device, remove it here — you can always
        sign in with your password or an email code.
      </p>
      {mfa.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : mfa.error ? (
        <p className="text-sm text-red-700">{(mfa.error as Error).message}</p>
      ) : factors.length === 0 ? (
        <p className="text-sm text-slate-500 italic">
          None registered. You're signing in with your password.
        </p>
      ) : (
        <ul className="divide-y divide-stone/60 border border-stone/60">
          {factors.map((f) => (
            <MfaRow
              key={f.id}
              factor={f}
              removing={remove.isPending}
              onRemove={() => {
                if (
                  window.confirm(
                    `Remove this ${MFA_TYPE_LABEL[f.type] ?? f.type}? You'll sign in with your password afterwards.`,
                  )
                ) {
                  remove.mutate(f.id);
                }
              }}
            />
          ))}
        </ul>
      )}
      {remove.error && (
        <p className="text-sm text-red-700">{(remove.error as Error).message}</p>
      )}
    </div>
  );
}

function MfaRow({
  factor,
  removing,
  onRemove,
}: {
  factor: MfaFactor;
  removing: boolean;
  onRemove: () => void;
}) {
  const label = MFA_TYPE_LABEL[factor.type] ?? factor.type;
  const detail = factor.name || factor.agent;
  return (
    <li className="px-3 py-2 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-graphite">{label}</div>
        <div className="text-xs text-slate-500 truncate">
          {detail && <span title={detail}>{detail}</span>}
          {detail && factor.created_at && " · "}
          {factor.created_at &&
            `added ${new Date(factor.created_at).toLocaleDateString()}`}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className="p-1.5 text-slate-500 hover:text-red-700 disabled:opacity-50 flex-shrink-0"
        aria-label={`Remove ${label}`}
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// My notifications — each user opts in/out of the emails sent to *them*.
// Visible to everyone (admins included).
// ──────────────────────────────────────────────────────────────────────────

function MyNotificationsSection() {
  const { data, isLoading } = useMyNotificationPrefs();
  const update = useUpdateMyNotificationPrefs();

  // Optimistic toggles — apply immediately and persist; React Query keeps the
  // cache in sync via onSuccess. Falls back to the fetched value pre-load.
  const assignment = data?.assignment_emails ?? true;
  const digest = data?.digest_emails ?? true;

  return (
    <Card accent="left" id="my-notifications" className="scroll-mt-6">
      <CardHeader>
        <h2 className="font-display text-2xl text-navy flex items-center gap-2">
          <BellIcon className="h-5 w-5 text-amber" aria-hidden />
          My notifications
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Choose which emails the portal sends to you. These only affect your
          own inbox.
        </p>
      </CardHeader>
      <CardBody>
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm text-graphite">
              <input
                type="checkbox"
                checked={assignment}
                disabled={update.isPending}
                onChange={(e) =>
                  update.mutate({ assignment_emails: e.target.checked })
                }
                className="h-4 w-4 mt-0.5 accent-amber"
              />
              <span>
                Email me when an invoice is assigned to me
                <span className="block text-xs text-slate-500">
                  A one-time email the moment something lands in your queue.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-graphite">
              <input
                type="checkbox"
                checked={digest}
                disabled={update.isPending}
                onChange={(e) =>
                  update.mutate({ digest_emails: e.target.checked })
                }
                className="h-4 w-4 mt-0.5 accent-amber"
              />
              <span>
                Send me the daily review digest
                <span className="block text-xs text-slate-500">
                  A once-a-day summary of invoices waiting on you. Only sent on
                  days you have pending invoices.
                </span>
              </span>
            </label>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Notifications — daily review digest schedule + a "send now" test. Admins+.
// ──────────────────────────────────────────────────────────────────────────

function NotificationsSection() {
  const me = useMe();
  const role = me.data?.role ?? "member";
  const canManage = ROLE_RANK[role] >= ROLE_RANK.admin;

  const { data } = useNotificationSettings({ enabled: canManage });
  const update = useUpdateNotificationSettings();
  const runDigest = useRunDigestNow();

  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState("07:30");
  const [tz, setTz] = useState("America/Chicago");
  const [digestResult, setDigestResult] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate form from fetched settings
      setEnabled(data.daily_digest_enabled);
      setTime(data.daily_digest_time);
      setTz(data.daily_digest_timezone);
    }
  }, [data]);

  const dirty =
    !!data &&
    (enabled !== data.daily_digest_enabled ||
      time !== data.daily_digest_time ||
      tz !== data.daily_digest_timezone);

  async function save() {
    await update.mutateAsync({
      daily_digest_enabled: enabled,
      daily_digest_time: time,
      daily_digest_timezone: tz,
    });
  }

  async function sendNow() {
    setDigestResult(null);
    const r = await runDigest.mutateAsync();
    setDigestResult(
      r.skipped
        ? "Email isn't configured (RESEND_API_KEY)."
        : `Sent to ${r.recipients} recipient${r.recipients === 1 ? "" : "s"} (${r.pending_users} with pending invoices` +
            (r.opted_out ? `, ${r.opted_out} opted out` : "") +
            ").",
    );
  }

  return (
    <Card accent="left" id="notifications" className="scroll-mt-6">
      <CardHeader>
        <h2 className="font-display text-2xl text-navy flex items-center gap-2">
          <BellIcon className="h-5 w-5 text-amber" aria-hidden />
          Notifications
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          A daily email reminds each reviewer of the ready-for-review invoices
          assigned to them.
        </p>
      </CardHeader>
      <CardBody>
        {!canManage ? (
          <p className="text-sm text-slate-500">
            Admins manage notification settings.
          </p>
        ) : (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-graphite">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 accent-amber"
              />
              Send the daily review digest
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Send time"
                labelTone="quiet"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={!enabled}
              />
              <Select
                label="Timezone"
                labelTone="quiet"
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                disabled={!enabled}
              >
                {(TZ_OPTIONS.includes(tz) ? TZ_OPTIONS : [tz, ...TZ_OPTIONS]).map(
                  (z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ),
                )}
              </Select>
            </div>

            {data?.daily_digest_last_sent_on && (
              <p className="text-xs text-slate-500">
                Last digest sent: {data.daily_digest_last_sent_on}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={save} loading={update.isPending} disabled={!dirty}>
                Save
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={sendNow}
                loading={runDigest.isPending}
              >
                Send digest now
              </Button>
              {digestResult && (
                <span className="text-xs text-slate-600">{digestResult}</span>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// AP Coding section — manages dropdown options for job/cost code/approver.
// Visible to admins+. Members see a brief notice instead.
// ──────────────────────────────────────────────────────────────────────────

const FIELDS: { key: CodingField; description: string }[] = [
  {
    key: "job_number",
    description: "Cambridge job codes (e.g. 25-11-04). Reusable across projects.",
  },
  {
    key: "cost_code",
    description: 'Cost classification (e.g. 01-520 "O"). Maps to internal accounting.',
  },
  {
    key: "approver",
    description: "Initials of whoever signs off the markup (e.g. jwh).",
  },
];

function APCodingSection() {
  const me = useMe();
  const role = me.data?.role ?? "member";
  const canManage = ROLE_RANK[role] >= ROLE_RANK.admin;

  const { data, isLoading } = useCodingOptions();
  const grouped = groupByField(
    (data?.options ?? []).filter((o) => o.active || canManage),
  );

  return (
    <Card accent="left" id="coding" className="scroll-mt-6">
      <CardHeader>
        <h2 className="font-display text-2xl text-navy flex items-center gap-2">
          <TagIcon className="h-5 w-5 text-amber" aria-hidden />
          AP coding options
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Curated dropdowns shown when reviewing invoices. PMs can still
          enter custom values, but pre-defined options reduce typos and
          keep codes consistent.
        </p>
      </CardHeader>
      <CardBody>
        {!canManage && (
          <p className="text-sm text-slate-500">
            Admins manage these options. You'll see the dropdowns when reviewing
            invoices.
          </p>
        )}
        {canManage && (
          <div className="space-y-6">
            {FIELDS.map((f) => (
              <FieldGroup
                key={f.key}
                field={f.key}
                description={f.description}
                options={grouped[f.key]}
                loading={isLoading}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function FieldGroup({
  field,
  description,
  options,
  loading,
}: {
  field: CodingField;
  description: string;
  options: CodingOption[];
  loading: boolean;
}) {
  const create = useCreateCodingOption();
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAdding(false);
    setNewValue("");
    setNewLabel("");
    setError(null);
  }

  async function handleAdd() {
    setError(null);
    const v = newValue.trim();
    if (!v) {
      setError("Value is required");
      return;
    }
    try {
      await create.mutateAsync({
        field,
        value: v,
        label: newLabel.trim() || null,
      });
      reset();
    } catch (e) {
      setError((e as Error).message || "Failed to add");
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <SectionLabel>{FIELD_LABELS[field]}</SectionLabel>
          <p className="text-xs text-slate-500 mt-0.5">{description}</p>
        </div>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon className="h-4 w-4" />
            Add
          </Button>
        )}
      </div>

      {/* Add row */}
      {adding && (
        <div className="bg-stone/40 border border-amber/30 p-3 mb-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 items-end">
            <Input
              label="Value"
              labelTone="quiet"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={field === "approver" ? "jwh" : "25-11-04"}
              className="font-mono"
              size="sm"
            />
            <Input
              label="Label (optional)"
              labelTone="quiet"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Lobby Renovation"
              size="sm"
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleAdd}
                loading={create.isPending}
                disabled={!newValue.trim()}
              >
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
      )}

      {/* Existing options */}
      {loading && (
        <p className="text-xs text-slate-500">Loading…</p>
      )}
      {!loading && options.length === 0 && !adding && (
        <p className="text-xs text-slate-500 italic">
          No options yet. Click Add to create one.
        </p>
      )}
      {options.length > 0 && (
        <ul className="divide-y divide-stone/60 border border-stone/60">
          {options.map((opt) => (
            <CodingOptionRow key={opt.id} option={opt} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CodingOptionRow({ option }: { option: CodingOption }) {
  const patch = usePatchCodingOption();
  const del = useDeleteCodingOption();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(option.value);
  const [l, setL] = useState(option.label ?? "");

  async function save() {
    await patch.mutateAsync({
      id: option.id,
      patch: { value: v.trim(), label: l.trim() || null },
    });
    setEditing(false);
  }

  async function toggleActive() {
    await patch.mutateAsync({
      id: option.id,
      patch: { active: !option.active },
    });
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete "${option.value}"? Existing invoices keep their value but PMs won't see it in the dropdown.`,
      )
    ) {
      return;
    }
    await del.mutateAsync(option.id);
  }

  if (editing) {
    return (
      <li className="px-3 py-2 bg-amber/5">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 items-end">
          <Input
            label="Value"
            labelTone="quiet"
            value={v}
            onChange={(e) => setV(e.target.value)}
            className="font-mono"
            size="sm"
          />
          <Input
            label="Label"
            labelTone="quiet"
            value={l}
            onChange={(e) => setL(e.target.value)}
            size="sm"
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              loading={patch.isPending}
              disabled={!v.trim()}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setV(option.value);
                setL(option.label ?? "");
              }}
            >
              <XMarkIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="px-3 py-2 flex items-center justify-between gap-3 hover:bg-stone/30">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm text-graphite">
          {option.value}
          {!option.active && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-400">
              hidden
            </span>
          )}
        </div>
        {option.label && (
          <div className="text-xs text-slate-500 truncate">{option.label}</div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={toggleActive}
          disabled={patch.isPending}
          className="text-[10px] uppercase tracking-wider px-2 py-1 text-slate-500 hover:text-navy disabled:opacity-50"
          title={option.active ? "Hide from dropdowns" : "Show in dropdowns"}
        >
          {option.active ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="p-1.5 text-slate-500 hover:text-navy"
          aria-label="Edit"
        >
          <PencilIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={del.isPending}
          className="p-1.5 text-slate-500 hover:text-red-700 disabled:opacity-50"
          aria-label="Delete"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div
        className={
          mono
            ? "font-mono text-sm text-graphite"
            : "text-sm text-graphite"
        }
      >
        {value}
      </div>
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────────────
// Trusted email domains — controls the allowlist used by the email
// triage workflow. The qbo_sync block is read-only (auto-managed),
// the manual block is editable.
// ──────────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<TrustedDomain["source"], string> = {
  qbo_sync: "From QuickBooks",
  manual: "Manual",
  promoted_from_triage: "Trusted from triage",
};


function TrustedDomainsSection() {
  const me = useMe();
  const role = me.data?.role ?? "member";
  const canManage = ROLE_RANK[role] >= ROLE_RANK.admin;

  // Skip the network call entirely for non-admin users — the API
  // would 403 and we don't want to render a confusing error.
  const query = useTrustedDomains({ enabled: canManage });
  const add = useAddTrustedDomain();
  const remove = useRemoveTrustedDomain();

  const [draftDomain, setDraftDomain] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const domains = query.data?.domains ?? [];
    const buckets: Record<TrustedDomain["source"], TrustedDomain[]> = {
      qbo_sync: [],
      manual: [],
      promoted_from_triage: [],
    };
    for (const d of domains) buckets[d.source].push(d);
    return buckets;
  }, [query.data?.domains]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!draftDomain.trim()) return;
    try {
      await add.mutateAsync({
        domain: draftDomain.trim(),
        notes: draftNotes.trim() || null,
      });
      setDraftDomain("");
      setDraftNotes("");
    } catch (exc) {
      setError(
        exc instanceof Error
          ? exc.message
          : "Could not add domain — try a different format.",
      );
    }
  };

  const handleRemove = async (id: string) => {
    setError(null);
    try {
      await remove.mutateAsync(id);
    } catch (exc) {
      setError(
        exc instanceof Error
          ? exc.message
          : "Could not remove this domain.",
      );
    }
  };

  return (
    <Card accent="left" id="domains" className="scroll-mt-6">
      <CardHeader>
        <h2 className="font-display text-2xl text-navy flex items-center gap-2">
          <ShieldCheckIcon className="h-5 w-5 text-amber" aria-hidden />
          Trusted email domains
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Senders from these domains skip the "Unknown sender" triage
          path. We auto-populate from your QuickBooks vendor emails on
          every sync — add manual entries here for partners not in QBO.
          Vendors on Gmail, Yahoo, etc. are trusted by their full address,
          not their domain.
        </p>
      </CardHeader>
      <CardBody>
        {!canManage ? (
          <p className="text-sm text-slate-500">
            Admins manage the allowlist. The triage workflow uses these
            domains to decide whether a sender is recognised.
          </p>
        ) : query.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : (
          <div className="space-y-6">
            {error && (
              <div className="border-l-2 border-red-700 bg-red-50 px-3 py-2 text-sm text-red-900">
                {error}
              </div>
            )}

            {/* Manual + promoted-from-triage entries — editable */}
            <div className="space-y-3">
              <SectionLabel>Manual entries</SectionLabel>

              <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[180px]">
                  <Input
                    label="Domain or email"
                    value={draftDomain}
                    onChange={(e) => setDraftDomain(e.target.value)}
                    placeholder="vendor.com or hi@vendor.com"
                  />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <Input
                    label="Note (optional)"
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Subcontractor, partner, etc."
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={add.isPending}
                  disabled={!draftDomain.trim() || add.isPending}
                >
                  <PlusIcon className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </form>

              {grouped.manual.length === 0 &&
              grouped.promoted_from_triage.length === 0 ? (
                <p className="text-sm text-slate-500 italic">
                  No manual entries yet. Use the form above to trust a
                  domain that isn't in QuickBooks.
                </p>
              ) : (
                <ul className="divide-y divide-stone/60">
                  {[...grouped.manual, ...grouped.promoted_from_triage].map(
                    (d) => (
                      <DomainRow
                        key={d.id}
                        domain={d}
                        onRemove={() => handleRemove(d.id)}
                        removing={remove.isPending}
                      />
                    ),
                  )}
                </ul>
              )}
            </div>

            {/* QBO-synced entries — read-only display */}
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <SectionLabel>From QuickBooks</SectionLabel>
                <span className="text-xs text-slate-400">
                  {grouped.qbo_sync.length} domains
                </span>
              </div>
              {grouped.qbo_sync.length === 0 ? (
                <p className="text-sm text-slate-500 italic">
                  No domains synced yet. Sync vendors from the
                  QuickBooks card above to populate.
                </p>
              ) : (
                <ul className="divide-y divide-stone/60">
                  {grouped.qbo_sync.map((d) => (
                    <DomainRow key={d.id} domain={d} readOnly />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}


function DomainRow({
  domain,
  onRemove,
  removing,
  readOnly,
}: {
  domain: TrustedDomain;
  onRemove?: () => void;
  removing?: boolean;
  readOnly?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <span className="font-mono text-sm text-navy break-all">
        {domain.domain}
      </span>
      <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
        {SOURCE_LABEL[domain.source]}
      </span>
      {domain.notes && (
        <span className="text-xs text-slate-500 italic min-w-0 truncate">
          {domain.notes}
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {domain.added_by_email && (
          <span className="text-xs text-slate-400 truncate max-w-[16ch]">
            {domain.added_by_email}
          </span>
        )}
        {!readOnly && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={removing}
            className="text-slate-400 hover:text-red-700 transition-colors p-1 disabled:opacity-50"
            aria-label={`Remove ${domain.domain}`}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </span>
    </li>
  );
}
