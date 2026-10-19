/**
 * Release history for the in-app "What's new" page. Each release is a plain,
 * user-facing description of what changed — features people can see and get
 * excited about, not code changes. Add a new object at the top of RELEASES
 * for each version; the page and the sidebar "new" badge follow automatically.
 */
import type { ComponentType, SVGProps } from "react";
import {
  ArrowUpTrayIcon,
  BellIcon,
  BookmarkIcon,
  BuildingStorefrontIcon,
  ChatBubbleBottomCenterTextIcon,
  CheckBadgeIcon,
  ClockIcon,
  Cog6ToothIcon,
  DevicePhoneMobileIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  FlagIcon,
  InboxIcon,
  KeyIcon,
  LinkIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  SparklesIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export interface ReleaseItem {
  Icon: Icon;
  title: string;
  body: string;
}

export interface ReleaseSection {
  kind: "new" | "improved";
  items: ReleaseItem[];
}

export interface Release {
  version: string;
  /** Human date, e.g. "June 24, 2026". */
  date: string;
  /** The one headline change. */
  headline: string;
  /** One-line intro. */
  summary: string;
  sections: ReleaseSection[];
}

export const RELEASES: Release[] = [
  {
    version: "0.2.6",
    date: "October 19, 2026",
    headline: "Fake invoices stay out of your queue",
    summary:
      "Invoices from senders the portal doesn't know now wait in Triage, every invoice shows who sent it, and bills post to QuickBooks under the right Product/Service.",
    sections: [
      {
        kind: "new",
        items: [
          {
            Icon: ShieldCheckIcon,
            title: "Unknown senders wait in Triage",
            body: "An invoice from an email domain the portal doesn't recognise goes to Triage with an \"Unknown sender\" flag instead of landing next to your regular invoices. One click on Trust sender + promote confirms a real vendor for good. Your QuickBooks vendors are already trusted.",
          },
          {
            Icon: ShieldExclamationIcon,
            title: "Sender verification",
            body: "Emails that fail the standard sender checks (SPF, DKIM and DMARC) are flagged \"Failed sender verification\" and held in Triage. This catches the nastier scam where someone pretends to be a vendor you already work with. Nothing is blocked or deleted; a real vendor just waits for your OK.",
          },
          {
            Icon: FlagIcon,
            title: "Report as suspicious",
            body: "If an invoice looks like a scam, one click rejects it and sends the sender, subject and a link to RelentNet. Your team doesn't need to investigate or forward anything.",
          },
          {
            Icon: EnvelopeIcon,
            title: "Who sent it, on every invoice",
            body: "The sending address, and whether it's a trusted sender, now shows at the top of every emailed invoice, not just the ones in Triage.",
          },
        ],
      },
      {
        kind: "improved",
        items: [
          {
            Icon: CheckBadgeIcon,
            title: "Bills post under the right Product/Service",
            body: "Each cost code is now matched to its QuickBooks Product/Service, so a posted bill lands under Item details with the right item and project, the way accounting entered them by hand before. Check or change the matches in Settings under Cost code.",
          },
          {
            Icon: UserCircleIcon,
            title: "Gmail and Yahoo vendors are trusted by address",
            body: "Trusting a vendor who emails from Gmail, Yahoo or similar now trusts that exact address, never the whole provider.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.5",
    date: "July 24, 2026",
    headline: "Clearer coding, and posting stays with the admins",
    summary:
      "The cost code now shows its full description while you code, and posting to QuickBooks is limited to admins.",
    sections: [
      {
        kind: "improved",
        items: [
          {
            Icon: DocumentTextIcon,
            title: "The full cost code, not just the number",
            body: "When you're coding an invoice, each cost code now shows its full description right next to the number — in the dropdown and after you pick one — so you can see exactly what a code stands for at a glance.",
          },
          {
            Icon: CheckBadgeIcon,
            title: "Posting to QuickBooks is admin-only",
            body: "Project managers code and approve invoices as usual, and posting to QuickBooks now stays with owners and admins. An approved invoice waits in the Ready to Post list for an admin to send it over.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.4",
    date: "July 15, 2026",
    headline: "Your account, in your hands",
    summary:
      "A new Account section in Settings — change your password, update your name, and fix passkey lockouts yourself.",
    sections: [
      {
        kind: "new",
        items: [
          {
            Icon: UserCircleIcon,
            title: "An Account section in Settings",
            body: "Change your password (it asks for your current one first) and update the display name your teammates see — no admin needed.",
          },
          {
            Icon: KeyIcon,
            title: "Fix passkey lockouts yourself",
            body: "A passkey made on one device (say, Windows Hello on your PC) doesn't exist on your phone. If one is locking you out, remove it under Settings → Account and sign in with your password instead.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.3",
    date: "July 14, 2026",
    headline: "The app now tells you why",
    summary:
      "Two fixes that turn silent head-scratchers into plain answers.",
    sections: [
      {
        kind: "improved",
        items: [
          {
            Icon: ChatBubbleBottomCenterTextIcon,
            title: "No more silent buttons",
            body: "If a post or approval can't go through — say the invoice is missing its job number — the app now says so, right where you clicked, instead of quietly doing nothing.",
          },
          {
            Icon: DevicePhoneMobileIcon,
            title: "Expired sign-ins sort themselves out",
            body: "If your session expires (it happens most on phones), the portal now takes you straight back to the sign-in screen instead of filling the page with confusing connection errors.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.2",
    date: "July 1, 2026",
    headline: "Notifications on your terms",
    summary:
      "Decide which emails reach you — plus steadier QuickBooks posting and smarter vendor matching.",
    sections: [
      {
        kind: "new",
        items: [
          {
            Icon: EnvelopeIcon,
            title: "Assign without emailing",
            body: "Assigning an invoice now has an “Email the assignee” checkbox, so you can hand something off quietly or notify them — your call, every time.",
          },
          {
            Icon: BellIcon,
            title: "Choose your own notifications",
            body: "Settings → My notifications lets each person turn off assignment emails or the daily digest just for themselves, without affecting anyone else.",
          },
        ],
      },
      {
        kind: "improved",
        items: [
          {
            Icon: LinkIcon,
            title: "QuickBooks won't catch you out",
            body: "The app now warns you before posting can fail — when QuickBooks needs reconnecting, or when no default expense account is set — right on Settings and on the invoice. And reconnecting QuickBooks no longer clears your expense-account and project settings.",
          },
          {
            Icon: BuildingStorefrontIcon,
            title: "More accurate vendor matching",
            body: "Invoices now fill in the vendor only when it's a genuine match. An unfamiliar vendor used to occasionally be matched to the wrong one; now it's left for you to pick instead of guessing.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.1",
    date: "June 24, 2026",
    headline: "See what's new, right in the app",
    summary:
      "A small follow-up to the big one: every update now lives in the app, in plain English.",
    sections: [
      {
        kind: "new",
        items: [
          {
            Icon: SparklesIcon,
            title: "A “What's new” page",
            body: "You're reading it. Find it any time from the sidebar (or the More menu on mobile) — each release explained in plain language, so you can see what changed and what you can do now.",
          },
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    date: "June 24, 2026",
    headline: "Your invoice queue becomes a work inbox",
    summary:
      "The biggest update yet — the queue and review pages are rebuilt around getting work done, with a clearer workflow, a readable activity log, and email notifications.",
    sections: [
      {
        kind: "new",
        items: [
          {
            Icon: InboxIcon,
            title: "Your queue is now a work inbox",
            body: "Filter pills show exactly what needs you — Needs review, Assigned to me, Ready to post, Triage — each with a live count. Every invoice carries its next action right in the row, so you can claim, review, post, or reject without opening each one.",
          },
          {
            Icon: CheckBadgeIcon,
            title: "Approve without the assign dance",
            body: "Admins can review and approve any invoice directly, or hand one off to a teammate. Team members see what's assigned to them and claim it — so everyone can tell at a glance who has picked up what.",
          },
          {
            Icon: ClockIcon,
            title: "A plain-English activity log",
            body: "The audit log is now Activity: readable lines like “Brandon approved Acme Supply #INV-1042 · 2 hours ago,” grouped by day and filterable by person or activity. Flip on Detailed when you need the technical specifics.",
          },
          {
            Icon: BellIcon,
            title: "Email notifications",
            body: "Reviewers get an email the moment an invoice is assigned to them, a daily 7:30 digest of everything still waiting, and admins can send a manual nudge to anyone on the team.",
          },
        ],
      },
      {
        kind: "improved",
        items: [
          {
            Icon: DocumentTextIcon,
            title: "A calmer review page",
            body: "One header now shows the vendor, invoice number, total, status, and assignee, so the PDF and the coding fields stay front and center. It updates live as you type.",
          },
          {
            Icon: ArrowUpTrayIcon,
            title: "Upload stays out of the way",
            body: "Drag a PDF anywhere onto the queue, or use the Upload button. The big dropzone that used to hog the top of the page is gone.",
          },
          {
            Icon: Cog6ToothIcon,
            title: "Easier settings",
            body: "Each section has an icon, and the sidebar shows a jump-nav while you're in Settings so you can hop straight to QuickBooks, Notifications, or AP coding.",
          },
          {
            Icon: BookmarkIcon,
            title: "Bookmarkable views",
            body: "Your queue filter now lives in the page address, so you can bookmark or share a specific view.",
          },
        ],
      },
    ],
  },
];

export const CURRENT_VERSION = RELEASES[0].version;

const SEEN_KEY = "cbg:seenReleaseVersion";

/** Has the user already seen the latest release? Defaults to "yes" if storage
 *  is unavailable, so we never nag with a broken badge. */
export function releaseSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === CURRENT_VERSION;
  } catch {
    return true;
  }
}

export function markReleaseSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, CURRENT_VERSION);
  } catch {
    /* ignore */
  }
}
