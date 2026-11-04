// Single source of truth for the admin role/permission model. Pure constants and types only —
// no server-only or client-only imports — so both app/auth.ts (server) and
// app/admin/AdminClient.tsx (client) can import it without pulling in the other's runtime.

export const ALL_PERMISSIONS = [
  "read_admin",
  "create_deals",
  "publish_deals",
  "verify_deals",
  "manage_sponsorships",
  "manage_restaurant_photos",
  "moderate_suggestions",
  "moderate_feedback",
  "manage_email",
  "manage_users",
  "reopen_reports",
  "view_analytics",
  "manage_campaigns",
  "manage_finance",
  "export_data",
  "developer_tools",
] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  read_admin: "View the staff workspace and its data.",
  create_deals: "Create and edit deal drafts, including their restaurant, location, schedule, and content.",
  publish_deals: "Change a deal's lifecycle status — publish, pause, or archive one deal at a time.",
  verify_deals: "Mark a deal as verified against its source.",
  manage_sponsorships: "Toggle sponsored placement on a deal.",
  manage_restaurant_photos: "Upload or set a restaurant's photo.",
  moderate_suggestions: "Approve, convert, or reject publicly submitted deal suggestions.",
  moderate_feedback: "Triage tester feedback and public accuracy reports.",
  manage_email: "Manage mailing-list subscriber status.",
  manage_users: "Change user roles, hide accounts from other roles, invite or revoke restaurant managers, and request operator-switch changes.",
  reopen_reports: "Reopen an accuracy report or feedback item after it was completed. Supervisor level and above.",
  view_analytics: "Read the Growth analytics and campaign traffic. Anonymous product figures only.",
  manage_campaigns: "Create, edit, pause and end tracked campaigns, and link them to an affiliate.",
  manage_finance: "See revenue, subscription and affiliate finances; approve affiliates, decide commissions, request payouts and comp Pro.",
  export_data: "Download CSV exports from the staff workspace. Developer role only.",
  developer_tools: "See integration configuration, email delivery readiness and test-purchase details. Developer role only.",
};

// Account types with no admin workspace access at all, which instead open a workspace of their
// own. They resolve to zero admin permissions in app/auth.ts the same way "user" does — in code,
// not out of role_permissions — so no row in that table and no edit through the presets grid can
// ever hand one of them a way into /admin. What they can do lives entirely behind their own route
// and its own API. See docs/ROLES.md.
export const WORKSPACE_ROLES = ["creator", "restaurant"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

// Where each of them lands. A restaurant account's authority still comes from its restaurant_managers
// rows, not from the role — the role decides which workspace is theirs, never which restaurants.
export const WORKSPACE_HOME: Record<WorkspaceRole, string> = {
  creator: "/creator",
  restaurant: "/portal",
};

export function isWorkspaceRole(role: string): role is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(role);
}

// Role presets, stored in the role_permissions table. "user" always has zero permissions and
// "owner" is a fixed superset — neither is editable (see PRESET_GRID_ROLES below), and neither
// are the workspace roles above.
export const ALL_ROLES = ["owner", "admin", "supervisor", "finance_manager", "developer", "deal_editor", "moderator", "marketing", "analyst", "creator", "restaurant", "user"] as const;
export type PresetRole = (typeof ALL_ROLES)[number];

// "custom" is a per-person override (see user_permissions table) rather than a shared preset —
// assignable to one person at a time, not a row in role_permissions.
export const ASSIGNABLE_ROLES = [...ALL_ROLES, "custom"] as const;
export type Role = (typeof ASSIGNABLE_ROLES)[number];

// The owner preset is fixed (always every permission) so an owner can never soft-lock the
// workspace by editing it, and "user" always has zero permissions by definition — both are
// assignable per-person but neither is a real editable row in the presets grid, so showing them
// there was just a column of permanently-empty or permanently-full checkboxes.
export const PRESET_GRID_ROLES = ALL_ROLES.filter(
  (r): r is Exclude<PresetRole, "owner" | "user" | WorkspaceRole> => r !== "owner" && r !== "user" && !isWorkspaceRole(r),
);

// Roles whose permission set is decided in code and can never be edited through the API. The
// presets grid hides them for the same reason; this is the list the write path checks.
export const FIXED_PERMISSION_ROLES: readonly string[] = ["owner", "user", ...WORKSPACE_ROLES];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including granting and revoking every other role. Always keeps read and user-management access.",
  admin: "Full operational control over deals, moderation, email, campaigns, finance and users. Destructive and high-risk actions still need an owner's approval.",
  supervisor: "Leads the deal and moderation teams: everything a deal editor and a moderator can do, plus reopening completed reports.",
  finance_manager: "Owns the money: affiliates, commissions, payouts, revenue and subscription figures, comps and sponsorship contracts.",
  developer: "Technical access: integration configuration, delivery readiness, test purchases and CSV exports. No editorial or account powers.",
  deal_editor: "Creates, edits, publishes, and verifies deals, and manages restaurant photos.",
  moderator: "Reviews public suggestions, reports, and tester feedback.",
  marketing: "Manages the mailing list, campaigns and sponsorship placements.",
  analyst: "Read-only access to the staff workspace and its analytics, for reporting.",
  creator: "A content creator with no staff access. Works in the creator workspace: submits deals for review and sees the traffic their own link brings in.",
  restaurant: "A restaurant with no staff access. Works in the restaurant portal, on the restaurants it has been granted.",
  user: "A regular signed-in visitor with no staff workspace access.",
  custom: "An individually configured permission set for this one person, independent of any role preset.",
};

// One account's role can never be changed by anyone, including other owners. Unlike the generic
// "you can't demote yourself" guard (which follows whoever is currently signed in), it is pinned to
// a specific person so the workspace always has one owner no in-app action can ever lock out or
// hand to someone else. Who that is lives in app/auth.ts (isProtectedOwner), not here: this file is
// imported by the admin client, so anything in it ships to every browser, and the owner's address
// is not something to publish.

// Every write the admin API accepts, and the one permission that authorizes it. This is the whole
// authorization table for /api/admin: the handler looks an action up here and refuses anything it
// does not find, so a new action is denied by default until it is added. It lived inside the POST
// handler as a local const, which meant it was rebuilt per request and sat 600 lines away from the
// permission list it has to agree with; here, tests/permissions.test.mjs can check that the route
// and this table still cover exactly the same set of actions.
export const ACTION_PERMISSIONS: Record<string, Permission> = {
  sponsorship: "manage_sponsorships",
  create_sponsorship: "manage_sponsorships",
  update_sponsorship: "manage_sponsorships",
  // Also needs an owner's approval (OWNER_APPROVAL_ACTIONS): a deleted contract takes its click and
  // impression history with it.
  delete_sponsorship: "manage_sponsorships",
  save_deal: "create_deals",
  backfill_locations: "create_deals",
  // Approving a restaurant manager's edit writes the deal's content, which is this grant's job.
  review_deal_change: "create_deals",
  lifecycle: "publish_deals",
  // Pausing or archiving every deal in one named market. Never the whole platform (the handler
  // refuses that), and always behind an owner's approval.
  bulk_lifecycle: "publish_deals",
  // The draft review screen's decisions, one draft at a time. Publishing also verifies, so the
  // handler checks verify_deals on top of this.
  publish_drafts: "publish_deals",
  archive_drafts: "publish_deals",
  verify: "verify_deals",
  // Closing a renew-or-confirm reminder is saying the deal was checked, which is this grant's job.
  resolve_staff_reminder: "verify_deals",
  convert_suggestion: "moderate_suggestions",
  suggestion: "moderate_suggestions",
  // Changing a completed item (resolved or rejected) back also needs reopen_reports, which the
  // handler checks: once a report is closed, only a supervisor or above can reopen it.
  feedback: "moderate_feedback",
  report: "moderate_feedback",
  user: "manage_users",
  // Also role-gated to owner/admin inside the handler — see docs/ROLES.md.
  user_visibility: "manage_users",
  creator_profile: "manage_users",
  // The affiliate program is money first: approving an applicant sets the rate they are paid at.
  // It sits with the other finance decisions rather than with account management, so the
  // Affiliates section answers to one grant end to end.
  creator_application: "manage_finance",
  // Comping Pro is giving away the product, which is a finance decision.
  plan_grant: "manage_finance",
  // Changing who is credited (and paid) for an account's subscription. Readers can never change
  // their own referral code; this is the audited correction path. Also needs an owner's approval.
  referral_correction: "manage_finance",
  // Operator switches (free trials today). Also needs an owner's approval.
  setting: "manage_users",
  creator_pick: "manage_users",
  creator_commission: "manage_finance",
  // Sending money out of the platform balance. Also needs an owner's approval.
  affiliate_payout: "manage_finance",
  invite_restaurant_manager: "manage_users",
  revoke_restaurant_manager: "manage_users",
  // Owner-only inside the handler as well.
  set_role_permission: "manage_users",
  // An owner deciding a request another member of staff made for an owner-approval action. The
  // handler requires the owner role; the permission only keeps the table total.
  decide_owner_approval: "read_admin",
  // Withdrawing your own pending request.
  cancel_owner_approval: "read_admin",
  subscriber: "manage_email",
  accept_waitlist: "manage_email",
  set_restaurant_photo: "manage_restaurant_photos",
};

// DESTRUCTIVE AND HIGH-RISK ACTIONS NEED AN OWNER.
// Holding the action's permission lets somebody *ask*; only an owner can make it happen. A request
// from anyone else is stored in owner_approvals (drizzle/0071) and runs, exactly as it was asked,
// when an owner approves it in Admin → Approvals. An owner's own request runs at once. Either way
// the request has to carry `confirmed: true`, set by the confirmation dialog, so a stray call
// cannot fire one of these. Admin access is not owner access: an admin's request waits like
// anyone else's.
export const OWNER_APPROVAL_ACTIONS: readonly string[] = [
  "bulk_lifecycle",
  "delete_sponsorship",
  "affiliate_payout",
  "setting",
  "referral_correction",
];

export function needsOwnerApproval(action: string) {
  return OWNER_APPROVAL_ACTIONS.includes(action);
}

// PERMISSIONS ONLY ONE ROLE MAY HOLD.
// Exports and the developer tools belong to the developer role (and to owner, who holds
// everything). app/auth.ts strips them from every other role when it resolves permissions, so no
// preset edit and no custom permission set can hand them to anyone else - the guarantee is in code,
// like the owner superset, not in data that has to keep agreeing with it.
export const ROLE_LOCKED_PERMISSIONS: Partial<Record<Permission, readonly string[]>> = {
  export_data: ["owner", "developer"],
  developer_tools: ["owner", "developer"],
};

export function roleMayHold(role: string, permission: Permission) {
  const allowed = ROLE_LOCKED_PERMISSIONS[permission];
  return !allowed || allowed.includes(role);
}

/** Owner or admin: the role tier the audit log, hidden accounts and the Admin section answer to. */
export function isAdminTier(role: string) {
  return role === "owner" || role === "admin";
}

// The permission that gates the admin workspace itself. Reaching any of it means reading it.
export const ADMIN_ENTRY_PERMISSION: Permission = "read_admin";

export function formatRole(role: string) {
  return role.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
