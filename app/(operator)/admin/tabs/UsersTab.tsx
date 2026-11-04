"use client";
import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  Link2,
  Megaphone,
  Pencil,
  ShieldCheck,
  Store,
  X,
} from "lucide-react";
import { DialogFocus } from "../../DialogFocus";
import { useOwnerApprovalAction } from "../FinancePanels";
import { GatedButton } from "../GatedButton";
import { ListCount, ListEmpty, ListToolbar, listCountLabel, Pager, pageRows, selectRows } from "../../ListScope";
import {
  ALL_PERMISSIONS,
  ASSIGNABLE_ROLES,
  isWorkspaceRole,
  formatRole,
  PERMISSION_DESCRIPTIONS,
  type Role,
  ROLE_DESCRIPTIONS,
} from "../../../permissions";
import { isProUser, setsEqual, sqlDate } from "../format";
import type { AdminActionPayload, AdminUser } from "../types";
import { countryName, PanelHeader, StatePanel } from "../ui";
import { useListScope, useTabState, useWorkspace } from "../workspace";

// The Users section: every account (the newest 500, as GET /api/admin loads them), searchable and
// filterable, with one account open in a detail panel beside the list. Role changes, creator
// links and visibility are all changed from that panel; the server decides every one of them
// (owner-only rules for roles, owner/admin for visibility), and this screen only offers what the
// signed-in role could actually do.
//
// The Roles & permissions grid that used to sit under this list lives in RolesGrid.tsx now: it is
// about the access model, not about any one account.

const ALL = "";
// Signed-up windows for the "Joined" filter, in days.
const JOINED_WINDOWS: { value: string; label: string; days: number }[] = [
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "365", label: "Last 12 months", days: 365 },
  { value: "older", label: "Over a year ago", days: 365 },
];
const DAY_MS = 86_400_000;
// The plan filter reads both columns: "pro" with a past_due status is a different conversation
// from a paying Pro member, and neither is a free account.
const PLAN_FILTERS: { value: string; label: string; match: (u: AdminUser) => boolean }[] = [
  { value: "pro", label: "Pro (active or trialing)", match: (u) => isProUser(u) },
  { value: "trialing", label: "On a trial", match: (u) => u.plan_status === "trialing" },
  { value: "past_due", label: "Payment past due", match: (u) => u.plan_status === "past_due" },
  { value: "canceled", label: "Canceled", match: (u) => u.plan_status === "canceled" },
  { value: "free", label: "Free", match: (u) => !isProUser(u) && u.plan_status !== "past_due" },
];
const LANGUAGE_NAMES: Record<string, string> = { en: "English", fr: "French", es: "Spanish" };

const displayName = (u: AdminUser) => u.name || u.email;
const initials = (u: AdminUser) => (displayName(u) || "?").trim().charAt(0).toUpperCase() || "?";
const day = (value: string | null | undefined) => (value ? sqlDate(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Not recorded");

export default function UsersTab() {
  const { data, busy, action, isOwner, isAdminPlus, canManageUsers, canManageFinance, openTab, now } = useWorkspace();
  const { listQueryFor, setListQueryFor, pageFor, setPageFor } = useListScope();
  const [userRoleFilter, setUserRoleFilter] = useTabState("users.roleFilter", ALL),
    [planFilter, setPlanFilter] = useTabState("users.planFilter", ALL),
    [statusFilter, setStatusFilter] = useTabState("users.statusFilter", ALL),
    [countryFilter, setCountryFilter] = useTabState("users.countryFilter", ALL),
    [joinedFilter, setJoinedFilter] = useTabState("users.joinedFilter", ALL),
    [selectedId, setSelectedId] = useTabState<string | null>("users.selectedId", null);
  const detailRef = useRef<HTMLElement>(null);
  const [roleDialog, setRoleDialog] = useState<AdminUser | null>(null),
    [creatorDialog, setCreatorDialog] = useState<AdminUser | null>(null),
    [creatorHandle, setCreatorHandle] = useState(""),
    [creatorDisplayName, setCreatorDisplayName] = useState(""),
    [creatorPaused, setCreatorPaused] = useState(false),
    [creatorRate, setCreatorRate] = useState(""),
    [desiredRole, setDesiredRole] = useState<Role>("user"),
    [desiredCustomPermissions, setDesiredCustomPermissions] = useState<Set<string>>(new Set()),
    [roleReason, setRoleReason] = useState(""),
    [referralDialog, setReferralDialog] = useState<AdminUser | null>(null),
    [referralHandle, setReferralHandle] = useState(""),
    [referralReason, setReferralReason] = useState("");
  const ownerAction = useOwnerApprovalAction();
  const allUsers = useMemo(() => data?.users || [], [data?.users]);
  const options = useMemo(() => {
    const sorted = (values: (string | null | undefined)[]) => Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort();
    return {
      roles: sorted(allUsers.map((u) => u.role)),
      statuses: sorted(allUsers.map((u) => u.status)),
      countries: sorted(allUsers.map((u) => (u.country || "").toUpperCase())),
    };
  }, [allUsers]);
  const filtersOn = Boolean(userRoleFilter || planFilter || statusFilter || countryFilter || joinedFilter);
  const filteredUsers = useMemo(() => {
    const plan = PLAN_FILTERS.find((p) => p.value === planFilter);
    const joined = JOINED_WINDOWS.find((w) => w.value === joinedFilter);
    return allUsers.filter((u) => {
      if (userRoleFilter && u.role !== userRoleFilter) return false;
      if (plan && !plan.match(u)) return false;
      if (statusFilter && u.status !== statusFilter) return false;
      if (countryFilter && (u.country || "").toUpperCase() !== countryFilter) return false;
      if (joined) {
        // An account with no recorded signup date cannot be placed in any window.
        if (!u.created_at) return false;
        const age = now - sqlDate(u.created_at).getTime();
        if (joined.value === "older" ? age <= joined.days * DAY_MS : age > joined.days * DAY_MS) return false;
      }
      return true;
    });
  }, [allUsers, userRoleFilter, planFilter, statusFilter, countryFilter, joinedFilter, now]);
  const userList = selectRows(filteredUsers, (u) => `${u.name || ""} ${u.email} ${u.home_postal || ""} ${u.country || ""}`,
    { query: listQueryFor("users"), filtered: filtersOn, showAll: true });
  const userReset = [listQueryFor("users"), userRoleFilter, planFilter, statusFilter, countryFilter, joinedFilter].join("|");
  const userPage = pageRows(userList.matched, pageFor("users", userReset));
  const hiddenUserCount = allUsers.filter((u) => u.hidden).length;
  const canSetUserVisibility = isAdminPlus;
  const selected = allUsers.find((u) => u.id === selectedId) || null;
  const creatorProfileById = useMemo(
    () => new Map((data?.creatorProfiles || []).map((profile) => [profile.user_id, profile])),
    [data?.creatorProfiles],
  );
  const creatorFor = (userId: string) => creatorProfileById.get(userId) || null;
  const restaurantName = useMemo(
    () => new Map((data?.restaurants || []).map((r) => [r.id, r.name])),
    [data?.restaurants],
  );
  // Mirrors the server rule in /api/admin: the workspace roles grant no admin permission at all,
  // so handing one out is not a step toward anything and does not need an owner. Everything else
  // still does. The dropdown below offers only what the actor may actually assign — the server
  // refuses the rest regardless.
  const assignableRoles = (user: AdminUser | null) =>
    isOwner
      ? ASSIGNABLE_ROLES
      : ASSIGNABLE_ROLES.filter((role) => isWorkspaceRole(role) || (role === "user" && user && isWorkspaceRole(user.role)));
  const roleGrants = useMemo(
    () => new Set((data?.rolePermissions || []).map((rp) => `${rp.role}:${rp.permission}`)),
    [data?.rolePermissions],
  );
  const userPermissionsByUser = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const up of data?.userPermissions || []) {
      if (!map.has(up.user_id)) map.set(up.user_id, new Set());
      map.get(up.user_id)!.add(up.permission);
    }
    return map;
  }, [data?.userPermissions]);
  function effectivePermissionsFor(u: AdminUser): Set<string> {
    if (u.role === "custom") return userPermissionsByUser.get(u.id) || new Set();
    return new Set(ALL_PERMISSIONS.filter((p) => roleGrants.has(`${u.role}:${p}`)));
  }
  function select(u: AdminUser) {
    setSelectedId(u.id);
    // On a phone the panel sits under the list; bring it into view rather than leave the click
    // looking like it did nothing.
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches)
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function clearFilters() {
    setUserRoleFilter(ALL); setPlanFilter(ALL); setStatusFilter(ALL); setCountryFilter(ALL); setJoinedFilter(ALL);
    setListQueryFor("users")("");
  }

  // The nav and the page route already keep this tab from anyone without manage_users, and the
  // server sends them no accounts; this only covers a stale tab after a role change.
  if (!canManageUsers)
    return <StatePanel kind="error" title="Accounts are for people who manage users">Your role does not include managing users, so no accounts are loaded here. Ask an owner if you need this.</StatePanel>;

  const managerGrants = selected
    ? (data?.restaurantManagers || []).filter((m) => m.user_id === selected.id || (m.invited_email || "").toLowerCase() === selected.email.toLowerCase())
    : [];
  const customPermissions = selected?.role === "custom" ? Array.from(effectivePermissionsFor(selected)) : [];

  const filterSelect = (label: string, value: string, onChange: (v: string) => void, choices: { value: string; label: string }[], allLabel: string) => (
    <label className="city-select">
      <span className="sr-only">{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={ALL}>{allLabel}</option>
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <ChevronDown />
    </label>
  );

  return (
    <>
      <div className="sw-users">
        <section className="portal-card sw-users-list">
          <PanelHeader title="Accounts">
            Everyone who has signed up, newest first. Pick an account to see its plan, settings and access, and to change its role.
          </PanelHeader>
          <ListToolbar query={listQueryFor("users")} onQuery={setListQueryFor("users")} placeholder="Search by name, email, postal code or country" label="Search users" />
          <div className="sw-users-filters" role="group" aria-label="Filter accounts">
            {filterSelect("Filter by role", userRoleFilter, setUserRoleFilter, options.roles.map((r) => ({ value: r, label: formatRole(r) })), "All roles")}
            {filterSelect("Filter by plan", planFilter, setPlanFilter, PLAN_FILTERS, "All plans")}
            {filterSelect("Filter by account status", statusFilter, setStatusFilter, options.statuses.map((s) => ({ value: s, label: formatRole(s) })), "Any status")}
            {filterSelect("Filter by country", countryFilter, setCountryFilter, options.countries.map((c) => ({ value: c, label: countryName(c) })), "All countries")}
            {filterSelect("Filter by signup date", joinedFilter, setJoinedFilter, JOINED_WINDOWS, "Joined any time")}
            {(filtersOn || listQueryFor("users")) && <button type="button" className="sw-link" onClick={clearFilters}>Clear filters</button>}
          </div>
          <ListCount>
            {listCountLabel(userList, allUsers.length, "account", true)}
            {allUsers.length >= 500 && <span className="list-count-note">Only the newest 500 accounts are loaded.</span>}
            {canSetUserVisibility && hiddenUserCount > 0 && <span className="list-count-note"><EyeOff /> {hiddenUserCount} hidden from other roles</span>}
          </ListCount>
          {!allUsers.length ? (
            <StatePanel kind="empty" title="No accounts yet">Nobody has signed up, or none of the accounts are visible to your role. New sign-ups appear here as they arrive.</StatePanel>
          ) : (
            <ul className="sw-user-rows" aria-label="Accounts">
              {userPage.rows.map((u) => {
                const creator = creatorFor(u.id);
                return (
                  <li key={u.id} className={`${u.hidden ? "user-row-hidden " : ""}${u.id === selectedId ? "is-selected" : ""}`}>
                    <button type="button" className="sw-user-row" aria-current={u.id === selectedId ? "true" : undefined} onClick={() => select(u)}>
                      <i className="sw-avatar" aria-hidden="true">{initials(u)}</i>
                      <span className="sw-user-who">
                        <b>{displayName(u)}</b>
                        <small>{u.email}</small>
                      </span>
                      <span className="sw-user-badges">
                        <span className="role-badge" title={ROLE_DESCRIPTIONS[u.role as Role] || undefined}>{formatRole(u.role)}</span>
                        {isProUser(u) && <span className="role-badge pro-badge" title="Radar Pro subscriber">PRO</span>}
                        {u.hidden ? <span className="role-badge hidden-badge" title="Only owners and admins can see this account in this list."><EyeOff /> Hidden</span> : null}
                        {creator ? <span className={`role-badge creator-badge${creator.status === "paused" ? " paused" : ""}`}><Megaphone /> {creator.handle}</span> : null}
                      </span>
                      <small className="sw-user-meta">{[u.home_postal, u.country ? countryName(u.country.toUpperCase()) : null].filter(Boolean).join(" · ") || "No area"} · Joined {day(u.created_at)}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {allUsers.length > 0 && !userList.visible.length && (
            <ListEmpty>No account matches these filters. <button type="button" className="sw-link" onClick={clearFilters}>Clear filters</button> to see everyone again.</ListEmpty>
          )}
          <Pager paged={userPage} noun="account" onPage={setPageFor("users", userReset)} />
        </section>

        <section ref={detailRef} className="portal-card sw-user-detail" aria-label="Account details">
          {!selected ? (
            <StatePanel kind="empty" title="No account selected">Pick an account from the list to see its plan, settings and access.</StatePanel>
          ) : (() => {
            const u = selected;
            const creator = creatorFor(u.id);
            return (
              <>
                <header className="sw-user-detail-head">
                  <i className="sw-avatar sw-avatar-lg" aria-hidden="true">{initials(u)}</i>
                  <div>
                    <h2>{displayName(u)}</h2>
                    <small>{u.email}</small>
                  </div>
                  <button type="button" className="close" aria-label="Close account details" onClick={() => setSelectedId(null)}><X /></button>
                </header>

                <div className="sw-user-role">
                  <span className="role-badge">{formatRole(u.role)}</span>
                  <p>{ROLE_DESCRIPTIONS[u.role as Role] || "A role this workspace does not describe."}</p>
                  {u.role === "custom" && (
                    <p className="sw-user-custom">
                      {customPermissions.length ? <>Custom permissions: {customPermissions.map((p) => formatRole(p)).join(", ")}</> : "No permissions picked yet."}
                    </p>
                  )}
                </div>

                <dl className="sw-facts">
                  <div><dt>Plan</dt><dd>{formatRole(u.plan || "free")}{u.plan_status ? ` · ${formatRole(u.plan_status)}` : ""}{isProUser(u) && <span className="role-badge pro-badge">PRO</span>}</dd></div>
                  <div><dt>Account status</dt><dd>{formatRole(u.status || "active")}</dd></div>
                  <div><dt>Country</dt><dd>{u.country ? countryName(u.country.toUpperCase()) : "Not set"}</dd></div>
                  <div><dt>Postal / ZIP</dt><dd>{u.home_postal || "Not set"}</dd></div>
                  <div><dt>Language</dt><dd>{u.language ? LANGUAGE_NAMES[u.language] || u.language : "Not set"}</dd></div>
                  <div><dt>Time zone</dt><dd>{u.timezone || "Not set"}</dd></div>
                  <div><dt>Deal alerts</dt><dd>{u.alerts_enabled ? `On${u.alert_days ? ` · ${u.alert_days}` : ""}${u.alert_time ? ` at ${u.alert_time}` : ""}` : "Off"}</dd></div>
                  <div><dt>Joined</dt><dd>{day(u.created_at)}</dd></div>
                  <div><dt>Referral code</dt><dd>{u.referred_by ? <code>{u.referred_by}</code> : "None"}</dd></div>
                  {canSetUserVisibility && (
                    <div><dt>Visibility</dt><dd>{u.hidden ? "Hidden from every role except owner and admin" : "Visible to everyone who manages users"}</dd></div>
                  )}
                </dl>

                {(u.role === "creator" || creator) && (
                  <div className="sw-user-block">
                    <h3><Megaphone /> Creator profile</h3>
                    {creator ? (
                      <p>
                        Tracked link <code>radar.cheap/?c={creator.handle}</code>
                        {creator.display_name ? ` · shown as ${creator.display_name}` : ""}
                        {` · ${creator.status === "paused" ? "workspace paused" : "active"}`}
                        {typeof creator.commission_rate_bps === "number" ? ` · ${creator.commission_rate_bps / 100}% commission` : ""}
                      </p>
                    ) : <p>No creator workspace yet. Set a handle to give this creator a tracked link.</p>}
                    {creator && canManageFinance && (
                      <button type="button" className="sw-link" onClick={() => openTab("affiliates", `?q=${encodeURIComponent(creator.handle)}`)}>Open in Affiliates</button>
                    )}
                  </div>
                )}

                <div className="sw-user-block">
                  <h3><Store /> Restaurant access</h3>
                  {managerGrants.length ? (
                    <ul className="sw-grants">
                      {managerGrants.map((m) => (
                        <li key={m.id}>
                          <b>{restaurantName.get(m.restaurant_id) || "A restaurant outside the loaded list"}</b>
                          <small>{m.status === "active" ? "Manages this restaurant in the portal" : `Invitation ${m.status}`}{m.user_id ? "" : ` · sent to ${m.invited_email}`}</small>
                        </li>
                      ))}
                    </ul>
                  ) : <p>Manages no restaurants. Invitations are sent from the Restaurants section.</p>}
                </div>

                <div className="row-actions sw-user-actions">
                  <GatedButton
                    blocked={
                      u.isProtected ? "This account's role is permanently protected and cannot be changed by anyone, including other owners."
                      : u.id === data.currentUser?.id ? "You cannot change your own role."
                      : !assignableRoles(u).length ? "Your role cannot assign this account a different role."
                      : null
                    }
                    disabled={busy === `user-${u.id}`}
                    onClick={() => { setRoleDialog(u); setDesiredRole(u.role as Role); setDesiredCustomPermissions(effectivePermissionsFor(u)); setRoleReason(""); }}
                  >
                    {u.id === data.currentUser?.id || u.isProtected
                      ? <><ShieldCheck /> Role is protected</>
                      : <><Pencil /> Change role</>}
                    <span className="sr-only"> for {displayName(u)}</span>
                  </GatedButton>
                  {u.role === "creator" && (
                    <button
                      type="button"
                      disabled={busy === `creator_profile-${u.id}`}
                      title="Set the handle this creator's tracked link and attribution use."
                      onClick={() => { const p = creatorFor(u.id); setCreatorDialog(u); setCreatorHandle(p?.handle || ""); setCreatorDisplayName(p?.display_name || ""); setCreatorPaused(p?.status === "paused"); setCreatorRate(p ? String((p.commission_rate_bps ?? 2000) / 100) : "20"); }}
                    >
                      <Megaphone /> {creator ? "Creator link" : "Set up creator"}<span className="sr-only"> for {displayName(u)}</span>
                    </button>
                  )}
                  {canManageFinance && (
                    <button
                      type="button"
                      disabled={busy === `referral_correction-${u.id}`}
                      title="Correct the creator this account is credited to. Needs an owner's approval."
                      onClick={() => { setReferralDialog(u); setReferralHandle(u.referred_by || ""); setReferralReason(""); }}
                    >
                      <Link2 /> Correct referral<span className="sr-only"> for {displayName(u)}</span>
                    </button>
                  )}
                  {canSetUserVisibility && (
                    <GatedButton
                      blocked={u.id === data.currentUser?.id ? "You cannot hide your own account." : null}
                      disabled={busy === `user_visibility-${u.id}`}
                      title={u.hidden ? "Show this account to every role that can read the user list." : "Hide this account from every role except owner and admin."}
                      onClick={() => action({ action: "user_visibility", id: u.id, hidden: !u.hidden })}
                    >
                      {u.hidden ? <><Eye /> Show</> : <><EyeOff /> Hide</>}<span className="sr-only"> {displayName(u)}</span>
                    </GatedButton>
                  )}
                </div>
              </>
            );
          })()}
        </section>
      </div>
      {roleDialog && (() => {
        const noChange = desiredRole === roleDialog.role && (desiredRole !== "custom" || setsEqual(desiredCustomPermissions, effectivePermissionsFor(roleDialog)));
        return (
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop click-to-dismiss is a mouse convenience; the close button below is the keyboard-accessible dismissal
          <div className="overlay" onMouseDown={() => setRoleDialog(null)}>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only stops backdrop clicks from closing when they originate inside the dialog */}
            <section className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="role-title" onMouseDown={(event) => event.stopPropagation()}>
              <DialogFocus onClose={() => setRoleDialog(null)} />
              <button className="close" aria-label="Cancel role change" onClick={() => setRoleDialog(null)}><X/></button>
              <span className="kicker">OWNER AUTHORIZATION</span>
              <h2 id="role-title">Change {roleDialog.name || roleDialog.email}’s access</h2>
              <label className="typed-confirmation">
                Role preset
                <select value={desiredRole} onChange={(event) => setDesiredRole(event.target.value as Role)}>
                  {assignableRoles(roleDialog).map((value) => <option key={value} value={value} title={ROLE_DESCRIPTIONS[value]}>{formatRole(value)}</option>)}
                </select>
              </label>
              {desiredRole === "custom" ? (
                <div className="custom-permissions">
                  <small>Pick exactly which permissions {roleDialog.name || roleDialog.email} has. This person stops following the {formatRole(roleDialog.role)} preset.</small>
                  <div className="keyword-chips">
                    {ALL_PERMISSIONS.map((permission) => {
                      const active = desiredCustomPermissions.has(permission);
                      return (
                        <button
                          key={permission}
                          type="button"
                          className={`chip${active ? " active" : ""}`}
                          aria-pressed={active}
                          title={PERMISSION_DESCRIPTIONS[permission]}
                          onClick={() =>
                            setDesiredCustomPermissions((current) => {
                              const next = new Set(current);
                              if (next.has(permission)) next.delete(permission);
                              else next.add(permission);
                              return next;
                            })
                          }
                        >
                          {formatRole(permission)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <small className="custom-permissions-hint" title={ROLE_DESCRIPTIONS[desiredRole]}>
                  {formatRole(desiredRole)}: {ROLE_DESCRIPTIONS[desiredRole]}
                </small>
              )}
              <label className="typed-confirmation">
                Reason
                <textarea value={roleReason} onChange={(event) => setRoleReason(event.target.value)} maxLength={500}/>
              </label>
              <div className="editor-actions">
                <button onClick={() => setRoleDialog(null)}>Cancel</button>
                <button
                  className="primary"
                  disabled={!roleReason.trim() || noChange || busy === `user-${roleDialog.id}`}
                  onClick={async () => {
                    const payload: AdminActionPayload = { action: "user", id: roleDialog.id, role: desiredRole, reason: roleReason };
                    if (desiredRole === "custom") payload.permissions = Array.from(desiredCustomPermissions);
                    if (await action(payload)) setRoleDialog(null);
                  }}
                >
                  Apply
                </button>
              </div>
            </section>
          </div>
        );
      })()}
      {referralDialog && (() => {
        const handle = referralHandle.trim().toLowerCase().replace(/^@/, "");
        const valid = !handle || /^[a-z0-9][a-z0-9-]{1,31}$/.test(handle);
        const unchanged = handle === (referralDialog.referred_by || "");
        return (
          // Backdrop click-to-dismiss is a mouse-only convenience; the close button below remains
          // the fully keyboard-accessible way to dismiss this dialog.
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
          <div className="overlay" onMouseDown={() => setReferralDialog(null)}>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only stops backdrop clicks from closing when they originate inside the dialog */}
            <section className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="referral-title" onMouseDown={(event) => event.stopPropagation()}>
              <DialogFocus onClose={() => setReferralDialog(null)} />
              <button className="close" aria-label="Close" onClick={() => setReferralDialog(null)}><X /></button>
              <span className="kicker">REFERRAL CORRECTION</span>
              <h2 id="referral-title">{referralDialog.name || referralDialog.email}</h2>
              <p>
                Readers can never change their own referral code, so this is the only way it moves. It changes which
                creator earns on this account’s future payments; commissions already earned stay where they are. An
                owner has to approve it, and the old and new code are kept in the audit log with your reason.
              </p>
              <label className="typed-confirmation">
                Creator handle
                <input value={referralHandle} onChange={(event) => setReferralHandle(event.target.value)} placeholder="maya" autoComplete="off" spellCheck={false} />
                <small>{handle ? `Credit ${handle}` : "Leave empty to remove the referral."} Currently {referralDialog.referred_by || "none"}.</small>
                {!valid && <small className="field-error">A handle is 2–32 characters: lowercase letters, numbers and hyphens.</small>}
              </label>
              <label className="typed-confirmation">
                Reason
                <textarea value={referralReason} onChange={(event) => setReferralReason(event.target.value)} maxLength={500} />
              </label>
              <div className="editor-actions">
                <button onClick={() => setReferralDialog(null)}>Cancel</button>
                <button
                  className="primary"
                  disabled={!valid || unchanged || !referralReason.trim() || busy === `referral_correction-${referralDialog.id}`}
                  onClick={async () => {
                    const outcome = await ownerAction(
                      { action: "referral_correction", id: referralDialog.id, handle, reason: referralReason },
                      `referral_correction-${referralDialog.id}`,
                    );
                    if (outcome) setReferralDialog(null);
                  }}
                >
                  {isOwner ? "Apply correction" : "Ask an owner"}
                </button>
              </div>
            </section>
          </div>
        );
      })()}
      {creatorDialog && (() => {
        const existing = creatorFor(creatorDialog.id);
        const handle = creatorHandle.trim().toLowerCase();
        const valid = !handle || /^[a-z0-9][a-z0-9-]{1,31}$/.test(handle);
        return (
          // Backdrop click-to-dismiss is a mouse-only convenience; the close button below remains
          // the fully keyboard-accessible way to dismiss this dialog.
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
          <div className="overlay" onMouseDown={() => setCreatorDialog(null)}>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only stops backdrop clicks from closing when they originate inside the dialog */}
            <section className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="creator-title" onMouseDown={(event) => event.stopPropagation()}>
              <DialogFocus onClose={() => setCreatorDialog(null)} />
              <button className="close" aria-label="Close" onClick={() => setCreatorDialog(null)}><X /></button>
              <span className="kicker">CREATOR ACCOUNT</span>
              <h2 id="creator-title">{creatorDialog.name || creatorDialog.email}</h2>
              <p>
                The handle is the public half of this creator’s tracked link, and the key every attributed visit and
                sign-up is stamped with. Changing it does not move attribution that already exists, so treat it as
                permanent once they have shared it anywhere.
              </p>
              <label className="typed-confirmation">
                Handle
                <input value={creatorHandle} onChange={(event) => setCreatorHandle(event.target.value)} placeholder="maya" autoComplete="off" spellCheck={false} />
                <small>{handle ? `radar.cheap/?c=${handle}` : "Leave empty to remove this creator’s workspace."}</small>
                {!valid && <small className="field-error">2–32 characters: lowercase letters, numbers and hyphens, starting with a letter or number.</small>}
              </label>
              <label className="typed-confirmation">
                Display name
                <input value={creatorDisplayName} onChange={(event) => setCreatorDisplayName(event.target.value)} placeholder={creatorDialog.name || creatorDialog.email} autoComplete="off" />
              </label>
              <label className="typed-confirmation">
                Commission rate
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={creatorRate}
                  onChange={(event) => setCreatorRate(event.target.value)}
                  placeholder="20"
                  inputMode="decimal"
                />
                <small>Percent of every Radar Pro payment from this link. Only changes what is earned from here on — past commissions keep the rate they were earned at.</small>
              </label>
              <label className="toggle" htmlFor="creator-paused-toggle" aria-label="Pause this creator's workspace">
                <input id="creator-paused-toggle" type="checkbox" checked={creatorPaused} onChange={(event) => setCreatorPaused(event.target.checked)} />
                <span></span>
                <div><b>Workspace paused</b><small>Keeps the handle and everything attributed to it, but closes the workspace.</small></div>
              </label>
              <div className="editor-actions">
                <button onClick={() => setCreatorDialog(null)}>Cancel</button>
                <button
                  className={handle ? "primary" : "destructive"}
                  disabled={!valid || busy === `creator_profile-${creatorDialog.id}`}
                  onClick={async () => {
                    if (await action({
                      action: "creator_profile",
                      id: creatorDialog.id,
                      handle,
                      displayName: creatorDisplayName,
                      // Blank means "leave it alone", which the handler reads as unchanged —
                      // saving a name edit must not reset what someone is paid.
                      commissionRateBps: creatorRate.trim() === "" ? undefined : Math.round(Number(creatorRate) * 100),
                      status: creatorPaused ? "paused" : "active",
                      reason: handle ? `Creator handle set to ${handle}` : "Creator workspace removed",
                    })) setCreatorDialog(null);
                  }}
                >
                  {handle ? (existing ? "Save creator" : "Create workspace") : "Remove workspace"}
                </button>
              </div>
            </section>
          </div>
        );
      })()}
    </>
  );
}
