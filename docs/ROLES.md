# Roles, permissions, and who can do what

This is the reference for Radar's access model. It describes what ships today, not what is
planned. `tests/permissions.test.mjs` checks that every role, permission, and admin action named
in the code also appears here, so if you add one and skip this file, the test suite fails.

There are **four separate systems** that decide what a person can do. They do not overlap, and
confusing them is the most common mistake:

| System | Stored in | Governs | Where it is set |
| --- | --- | --- | --- |
| **Role and permissions** | `users.role`, `role_permissions`, `user_permissions` | The admin workspace at `/admin` | Admin → Users |
| **Restaurant manager grant** | `restaurant_managers` | The restaurant portal at `/portal`, for specific restaurants | Admin → invite a manager |
| **Creator profile** | `creator_profiles` | The creator workspace at `/creator`, and the handle attribution is stamped with | Admin → Users → Creator link |
| **Plan (free / Pro)** | `users.plan`, `users.plan_status` | Consumer features: tracked areas, alert radius, history depth | Stripe |

A Pro subscriber has no more admin access than anyone else. An owner has no Pro features unless
they also pay. A restaurant manager is not an admin, and neither is a creator.

---

## 1. The admin role and permission model

### How a person's permissions are resolved

`app/auth.ts` → `permissionsForUser()` decides, in this order:

1. Role `user`, `creator` or `restaurant` → **no permissions**, full stop. No database read. For the
   two workspace roles that is the whole guarantee they rest on: no row in `role_permissions`, no
   edit through the presets grid, and no hand-written database change can give one of them a way
   into `/admin`. Only changing the role itself can.
2. Role `owner` → **every permission in `ALL_PERMISSIONS`**, in code, not from the database.
   This is deliberate: the owner preset is not editable through the API, and resolving it in code
   means a bad migration or a hand-edited database cannot lock every owner out of the workspace.
3. Role `custom` → exactly the rows in `user_permissions` for that one person.
4. Any other role → the rows in `role_permissions` for that role.

So a preset role is shared — editing the `moderator` preset changes it for every moderator — while
`custom` is one person's individual set. Someone with role `custom` ignores `role_permissions`
entirely, and someone with a preset role ignores `user_permissions` entirely.

### The sixteen permissions

| Permission | What it allows |
| --- | --- |
| `read_admin` | Open the staff workspace and read its data. See "the entry permission" below. |
| `create_deals` | Create and edit deal drafts: restaurant, location, schedule, content. |
| `publish_deals` | Change a deal's lifecycle status, one deal at a time; ask an owner to pause or archive one named market. |
| `verify_deals` | Mark a deal as verified against its source. |
| `manage_sponsorships` | Toggle sponsored placement and manage sponsorship contracts. |
| `manage_restaurant_photos` | Upload or set a restaurant's photo. |
| `moderate_suggestions` | Approve, convert, or reject (with a reason) publicly submitted deal suggestions. |
| `moderate_feedback` | Triage tester feedback and public accuracy reports. |
| `reopen_reports` | Change a report or feedback item that has already been resolved or rejected. |
| `manage_email` | Manage mailing-list subscriber status and accept pilot waitlist entries. |
| `manage_users` | Change roles, edit role presets, and invite or revoke restaurant managers. |
| `view_analytics` | Read the Growth section and the workspace's anonymous traffic and engagement figures. |
| `manage_campaigns` | Create and edit tracked campaigns. |
| `manage_finance` | Affiliates, commissions, payouts, comped plans, revenue and subscription figures. |
| `export_data` | Download CSV exports (`GET /api/admin/export`). Developer role and owner only. |
| `developer_tools` | The Developer section: integrations, delivery readiness, test purchases. Developer role and owner only. |

`manage_users` is the one that can grant every other one (except the two role-locked ones below).
Treat it as the real administrative boundary.

### The workspace by role

Which sections each preset opens (`canOpenTab` in `app/(operator)/admin/sections.ts`, enforced by
`/admin/<section>` and by what `GET /api/admin` sends). ✓ opens and acts; 👁 opens read-only; – not shown.

| Section | Owner | Admin | Supervisor | Finance mgr | Developer | Deal editor | Moderator | Marketing | Analyst |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Overview, Deal inventory, Ended, Restaurants, Directory, Handbook | ✓ | ✓ | ✓ | 👁 | 👁 | ✓ | 👁 | 👁 | 👁 |
| Draft review | ✓ | ✓ | ✓ | – | – | ✓ | – | – | – |
| Market coverage | ✓ | ✓ | ✓ | 👁 | – | ✓ | – | 👁 | 👁 |
| Suggestions | ✓ | ✓ | ✓ | – | – | – | ✓ | – | – |
| Accuracy reports, Product feedback | ✓ | ✓ | ✓ (reopens) | – | – | – | ✓ (cannot reopen) | – | – |
| Mailing list | ✓ | ✓ | – | – | – | – | – | ✓ | – |
| Campaigns | ✓ | ✓ | 👁 | 👁 | – | – | – | ✓ | 👁 |
| Social slides (carousel images from live deals; reads only the public deals API) | ✓ | ✓ | – | – | – | – | – | ✓ | – |
| Growth | ✓ | ✓ | 👁 | 👁 | – | – | – | 👁 | 👁 |
| Affiliates | ✓ | ✓ | – | ✓ | – | – | – | – | – |
| Sponsorships | ✓ | ✓ | – | ✓ | – | – | – | ✓ | – |
| Users | ✓ | ✓ | – | – | – | – | – | – | – |
| Audit log | ✓ | 👁 | – | – | – | – | – | – | – |
| Admin (approvals, roles, money) | ✓ decides | ✓ asks, reads roles | own requests | ✓ money, own requests | – | own requests | – | own requests | – |
| Developer (integrations, exports) | ✓ | – | – | – | ✓ | – | – | – | – |

Every role can ask for an owner-approval action it holds the permission for; only an owner can
make it run. "Ended" and "Inventory" are readable by every role that opens the workspace, and
acting on a deal still takes the deal permissions.

### Role-locked permissions

`export_data` and `developer_tools` can only ever be held by the `owner` and `developer` roles
(`ROLE_LOCKED_PERMISSIONS` in `app/permissions.ts`). `permissionsForUser()` drops them from any
other role whatever `role_permissions` or `user_permissions` say, and `set_role_permission` refuses
to grant them to another preset or to a `custom` person. So an export is never one checkbox away
for an admin: it takes changing that person's role, which is owner-only.

An export is also a read. `GET /api/admin/export` needs `export_data` **and** whatever reading that
dataset needs: users needs `manage_users`, subscribers needs `manage_email`, the audit log needs the
owner or admin role. A developer can therefore export deals and restaurants; the people exports are
the owner's. Every export writes an `export_data` row to `audit_log` with the dataset, the filters
and the row count. There is no export built in the browser any more.

### Operator switches

`setting` (needs `manage_users`) flips a switch in `app_settings` without a deploy. Everything
runtime-configurable in Radar used to be an environment variable, which is the right home for a
secret and the wrong one for something somebody wants on for a weekend: a variable change needs a
deploy, and a deploy needs CI.

The set of keys that mean anything is an allow-list in `app/settings.ts`. A key outside it is refused
rather than written, so a typo cannot become a row nothing reads — which would look exactly like a
switch that does not work.

Current switches:

| Key | Default | What it does |
|---|---|---|
| `trials_enabled` | off | Whether a new subscriber is offered the 3-day free trial |

Switches are **readable** by anyone who can open the workspace and **writable** only with
`manage_users`. A switch whose state is invisible to half the staff is one somebody flips twice.
Every change is in the audit log with the actor and the key.

Turning trials off does not end a trial already running. Stripe owns that subscription, `trialing`
stays an entitled status, and it finishes the way it was sold.

### Comping a subscription

`plan_grant` (needs `manage_finance`) puts an account on Pro without a Stripe subscription behind it,
or takes that back. It exists because the alternative is editing the database by hand, which leaves
no record of who did it or why: a comped month after a bad experience, access held open while a
refund is sorted out, an App Review account that has to see the paid features.

Three things it deliberately does not do:

- **It never writes over Stripe's `plan_status`.** The action writes neither `plan` nor
  `plan_status` itself. `resolvePlan` decides both from every source at once: a web subscription,
  an App Store one, and the grants (`app/plan-resolution.ts`). While a Stripe subscription is
  live, the column stays Stripe's word. Otherwise a grant makes it say "active", as an App Store
  subscription does, and that is what makes a comp real Pro everywhere Pro is checked. A grant that
  only set `plan` was recorded and granted nothing.
- **It never deletes.** Revoking marks the grant closed and leaves the row, so the history of who
  was given what stays readable.
- **It never drops a paying customer to free.** Revoking a comp resolves the plan from whatever is
  left, so an account that has both a real subscription and a comp keeps the subscription.

An expiry is a plain date, and the day it names is still covered (in UTC). The hourly billing job
(`app/api/jobs/billing`) takes Pro back once that date has passed, so a comped month ends by itself.
A date that has already passed is refused.

A reason is required, as it is for a role change, and every grant and revocation is in the audit log.
Active grants are listed in the Comped accounts panel (the Admin area, for `manage_finance`) so "who has Pro without paying" has an answer on screen.

### What each part of the workspace reads

`GET /api/admin` gates every read, not just every write, so a role's payload carries only what
its sections render:

| Data | Needs |
| --- | --- |
| Deals, restaurants, coverage list, deal totals, drink-rule alerts, settings, staff directory | `read_admin` |
| Draft review, review queue, renew-or-confirm reminders | `create_deals`, `publish_deals` or `verify_deals` |
| Coverage by country / province / city / postal area | deal work or `view_analytics` |
| Suggestions | `moderate_suggestions` |
| Reports and feedback | `moderate_feedback` |
| Users, restaurant managers | `manage_users` (hidden accounts: owner and admin only) |
| Mailing list, consents, waitlist | `manage_email` |
| Engagement counts, leaderboards, subscription headcounts | `view_analytics` (or `manage_users`; headcounts also `manage_finance`) |
| Growth section's date-ranged figures (`GET /api/admin/growth`): engagement trends, most-saved deals, deal performance, quiet inventory, visits, search demand, launch signals | `view_analytics` |
| Recording a verdict on a flagged search term (`POST /api/admin/growth`, audited as `search_term_verdict`) | `view_analytics` |
| Campaign traffic, and campaign records with their performance (`GET /api/admin/campaigns`, last 180 days) | `manage_campaigns`, `view_analytics` or `manage_finance` |
| Sponsorships | `manage_sponsorships` |
| Affiliates, commissions, payouts, balances, revenue, subscription movement, comps | `manage_finance` |
| Roles & permissions grid, custom permissions | owner or admin (editing: owner) |
| Audit log | owner or admin |
| Integration status and delivery readiness detail | `developer_tools` |
| Owner approvals | the owner sees all; anyone else, their own requests |

Without the grant a read arrives empty rather than as an error, so a narrower role sees a page
that works with fewer panels on it. The pages at `/admin/<section>` apply the same rules
(`canOpenTab` in `app/(operator)/admin/sections.ts`) and redirect to the overview otherwise.

### The entry permission

`read_admin` gates the workspace itself. `canAdminister()` checks for exactly this permission, and
so does `GET /api/admin` and the coarse gate on `POST /api/admin`.

This matters for `custom` roles: a person given, say, only `moderate_feedback` and not
`read_admin` cannot enter the workspace at all, and the "Admin workspace" link does not appear in
their dashboard. Granting a write permission without `read_admin` grants nothing usable — always
include `read_admin`.

### The roles

| Role | Permissions | Intended for |
| --- | --- | --- |
| `owner` | All sixteen, resolved in code | The people ultimately responsible for the account. The only role that can authorize high-risk actions. |
| `admin` | Everything except `export_data` and `developer_tools`, from the preset | Day-to-day full operational control |
| `supervisor` | `read_admin`, `create_deals`, `publish_deals`, `verify_deals`, `manage_restaurant_photos`, `moderate_suggestions`, `moderate_feedback`, `reopen_reports`, `view_analytics` | Leads the deal and moderation teams; the first role that can reopen a completed report |
| `finance_manager` | `read_admin`, `manage_finance`, `manage_sponsorships`, `view_analytics` | Affiliates, payouts, comps, revenue and sponsorship contracts |
| `developer` | `read_admin`, `export_data`, `developer_tools` | Integrations, delivery readiness, test purchases and exports; nothing editorial |
| `deal_editor` | `read_admin`, `create_deals`, `publish_deals`, `verify_deals`, `manage_restaurant_photos` | Someone who sources and maintains deals but does not touch users, email, or money |
| `moderator` | `read_admin`, `moderate_suggestions`, `moderate_feedback` | Reviewing what the public submits |
| `marketing` | `read_admin`, `manage_email`, `manage_sponsorships`, `view_analytics`, `manage_campaigns` | The mailing list, campaigns and paid placement |
| `analyst` | `read_admin`, `view_analytics` | Read-only reporting. Cannot change anything. |
| `creator` | None. Opens `/creator` instead | A content creator: submits deals for review, and sees what their link brings in. |
| `restaurant` | None. Opens `/portal` instead | A restaurant: edits the deals on the restaurants it has been granted. |
| `user` | None | Every ordinary signed-in visitor. The default for a new account. |

The presets come from `drizzle/0071_staff_workspace_access.sql`. Existing presets kept everything
they had; they only gained the new permissions that match work they already did.

Plus `custom`, which is not a preset — it is a per-person set, assignable to one person at a time.

The `owner`, `user`, `creator` and `restaurant` presets are not editable and are not shown in the
admin presets grid (`PRESET_GRID_ROLES`), because they would be a column of permanently-full or
permanently-empty checkboxes. `POST /api/admin` with `set_role_permission` rejects all four
(`FIXED_PERMISSION_ROLES`) — a row written for one of them would be silently ignored by
`permissionsForUser()` and would read as a grant that is not one.

### Who may assign a role

The `user` action normally requires **owner**. The two workspace roles are the exception: anyone
with `manage_users` may move an account to `creator` or `restaurant`, and may move it back to `user`
again. Onboarding a creator or a restaurant is day-to-day staff work, and because those roles
resolve to zero admin permissions in code, handing one out is not a step toward any other
permission — the escalation risk that makes role changes owner-only is simply not present. Every
other role change, in either direction, still requires an owner.

---

## 1a. The two workspace account types

Both are ordinary accounts that happen to open somewhere other than `/dashboard`. Neither can
reach `/admin`, `GET /api/admin`, or `POST /api/admin` — `canAdminister()` is false for them, and
the coarse gate on the admin API refuses them before any action is looked up.

### Creators (`/creator`, `POST /api/creator`)

A creator needs **both** the role and an `active` row in `creator_profiles`. The page checks both
on entry and the API checks both on every request; pausing the profile closes the workspace while
leaving the role and all existing attribution intact, which is the reversible way to switch
someone off.

- **Submissions** are `suggestions` rows, not a parallel table — the same reviewed-deal pipeline
  the public suggestion form feeds, so staff triage creator work in the queue they already use,
  and `convert_suggestion` publishes it the same way. A creator may edit or withdraw a submission
  only while it is still `pending`; once reviewed it is locked, so nothing changes under a
  reviewer. `withdrawn` is a fourth status only a creator can set, and only on their own rows.
- **The handle** (`creator_profiles.handle`) is the public half of their tracked link,
  `radar.cheap/?c=<handle>`. It is staff-set and unique; a creator can neither choose nor change
  their own. Changing it does not move attribution that already names the old one.
- **Attribution** is three facts and no more. A visit through the link writes a `campaign_visit`
  product event carrying the handle. A sign-up writes `users.referred_by`, once, at the moment the
  account row is first created, read from a 30-day cookie and only ever for a handle that resolves
  to an active creator — so an existing account cannot be re-attributed by clicking a link, and
  the cookie cannot name someone who is not a creator. There is no per-deal click metric anywhere
  in Radar, so the workspace reports where visits landed rather than inventing one.
- **A referral code** is the same handle typed in by the reader instead of clicked
  (`app/referral-code.ts`): on the sign-up page (checked by `POST /api/referral-code`, parked in the
  httpOnly `radar_referral_code` cookie, and re-checked by `app/auth.ts` when the row is created),
  or from the dashboard's Account section within 7 days of sign-up (`referral_code` on
  `/api/user`). It writes the same `users.referred_by`, so commissions accrue exactly as for a
  link. One per account; the reader can never change or remove it once set, enforced in the
  `UPDATE ... WHERE referred_by IS NULL` itself. Every one is audit-logged as `referral_code_set`.
  Staff fix a wrong one with `referral_correction` (`manage_finance`, owner approval, a reason;
  only future commissions move). A typed code is recorded even with GPC on, since the reader
  entered it; link cookies still are not.
- **A campaign label** (`?c=<handle>&camp=<label>`) is the optional fourth piece, and it travels
  the same path one level down: recorded on the visit, parked in its own cookie, written to
  `users.referred_campaign` beside the handle at account creation, and copied onto
  `creator_commissions.campaign` when that account pays. It is only ever read once the handle has
  resolved to an active creator, so a label with nobody behind it is never stored. A link with no
  label clears the cookie rather than leaving it, so an earlier video cannot claim a later visit.
  Creators build these themselves in the workspace; nothing is registered in advance.

- **Picks** (`creator_picks`) are the one thing in the program that is editorial rather than
  measured: up to twelve live deals a creator puts their name on, each with an optional line of
  their own, capped at 140 characters. They surface in two places — a rail on the home page for
  anyone arriving through that creator's link or holding their 30-day cookie, and a byline on the
  deal's own page for everybody. Only deals that are `live`, `active` and not deleted can be
  picked, checked at write time and again at read time, so a byline never points at a page nobody
  can open. Where two creators pick the same deal the earliest wins the byline, the same
  first-touch rule attribution uses. Pausing a profile hides that creator's picks immediately
  without deleting them, so reinstating somebody does not mean rebuilding their list.

  A note is third-party copy published under Radar's own domain, so **staff can remove a pick
  (`creator_pick`, gated on `manage_users`) but cannot write or edit one.** Moderation is a
  takedown, never a rewrite: an admin tool that could put words beside a named creator would make
  every byline on the site deniable. Editing belongs to the creator alone, in their workspace.
  Removals are audited with the handle and the deal.

- **Becoming a creator** starts at `/for-creators`, which writes a `creator_applications` row
  for the signed-in account. Applying reserves nothing: the requested handle is a request, and
  `creator_profiles` is not touched until a reviewer approves, which is what stops an application
  from taking a name or impersonating a known creator. Approving (`creator_application`, gated on
  `manage_finance`) does the role change, the profile and the handle in one batch, and only promotes
  an account whose role is still `user` so an existing admin or restaurant manager cannot be
  demoted into a creator by an approval. Rejecting needs a written reason, which the applicant is
  emailed; a blank one is refused.
- **An affiliate's labeled links** are `campaigns` rows carrying their handle (see
  `GET/POST /api/admin/campaigns`). The row stores the handle only; the affiliate's name, rate and
  status are always read from `creator_profiles`.
- **Commission** on Radar Pro is a share of every paid invoice, not a one-off bounty. The Stripe
  `invoice.paid` webhook reads the subscriber's `users.referred_by`, and if it names an `active`
  creator writes one `creator_commissions` row: amount and currency exactly as Stripe reported
  them, in integer minor units, with the creator's rate stamped on the row so a later rate change
  cannot rewrite history. A unique index on `invoice_id` is what makes a webhook retry safe.
  Deciding a row (`creator_commission`, gated on `manage_finance`) marks it `approved`,
  `void` or `rejected` and never deletes it. The two halves are deliberately different grants:
  paying affiliates does not let someone create creator accounts, and the reverse.
- **Being paid** is Stripe Connect, not a status change. Staff cannot mark a commission `paid`:
  that word is written in exactly one place, by the webhook branch that sees a Stripe transfer
  settle. A commission sits `pending` for `DEFAULT_HOLD_DAYS` (30) while refunds can still land,
  the hourly cron matures it to `approved`, and a payout — requested by the affiliate at
  `affiliate.radar.cheap`, or by staff (`affiliate_payout`, gated on `manage_finance` and an owner's approval) —
  claims it, transfers the money to the affiliate's Express account, and only then marks it
  `paid`. Radar stores the connected account's id and nothing else; the bank details, the tax
  identity and the verification documents live at Stripe. A failed transfer hands every
  commission in it back to the affiliate's available balance.

### Affiliates (`affiliate.radar.cheap`, `GET/POST /api/affiliate`)

The affiliate portal is the creator program's money half, under its own name. There is no second
account system and no second sign-in: it is the same Worker, the same Clerk instance and the same
`creator_profiles` row, served at a second hostname by a rewrite in `worker/index.ts`. Being an
affiliate is not a role — it is an `active` `creator_profiles` row, which `/api/affiliate` resolves
from the signed-in user's id and never from anything in the request. A signed-in Radar user who is
not an affiliate gets the portal shell with an invitation in it rather than a 403.

### Restaurants (`/portal`, `POST /api/portal`)

The `restaurant` role does **not** grant portal access. Authority there is, and remains, an
`active` `restaurant_managers` row for the specific restaurant — most managers predate this
account type and still hold role `user`, and every portal request re-checks the row rather than
trusting the role. What the role changes is the dead end: a restaurant account with no restaurant
granted yet sees the portal and is told it is waiting on one, instead of being bounced to the
dashboard with no explanation.

Restaurant accounts edit the deals on their restaurants — title, price, schedule, description,
terms, and pause/unpause. They cannot create deals; new deals come from staff.

### The pinned owner

`isProtectedOwner()` in `app/auth.ts` names one account whose role cannot be changed by
anyone, including another owner. It is server-only on purpose: `/api/admin` sends each user row
with an `isProtected` flag, and the admin client draws the lock from that, so the owner's address
never ships in the browser bundle. This is stronger than the generic "you cannot demote yourself"
guard, which follows whoever is currently signed in. It exists so the workspace always has one
owner that no sequence of in-app actions can lock out or hand to someone else.

`preserveOwner()` in `app/auth.ts` also restores that account to `owner` the first time it signs
in, once, recorded in `audit_log` as `owner_identity_migrated` so it cannot silently re-promote
someone later.

### Hidden accounts

`users.hidden` keeps one account out of the admin user list for every role except **owner** and
**admin**. It is filtered in SQL, in the same query that builds the list, so a hidden row never
reaches a browser that is not allowed to see it.

This is the one place in the model gated on the *role* rather than on a permission, and that is
deliberate: a `custom` role can be granted `manage_users`, and the entire point of hiding an
account is that holding that permission is not by itself enough to see it. The same two roles that
can see hidden accounts are the two that can set the flag (`user_visibility`), and nobody can hide
their own account — the row you would click to undo it is the row that just disappeared.

**What this is not.** It is not a security boundary and should never be used as one. A hidden
account behaves exactly like any other everywhere else in the product: it still appears in
aggregate counts, in the audit log, in the mailing list where it qualifies, and to anyone who can
read the database directly. It exists so that staff and test accounts do not sit in the list every
operator scrolls past. Every change to the flag is recorded in `audit_log` with the target's email.

---

## 2. What each admin action requires

`POST /api/admin` takes an `action` and looks it up in `ACTION_PERMISSIONS` (`app/permissions.ts`).
**An action with no entry in that table is refused** — authorization is an allowlist, so a new
action is denied to everyone, owners included, until it is added.

| Permission | Actions |
| --- | --- |
| `read_admin` | `decide_owner_approval` (owner role only, checked in the handler), `cancel_owner_approval` (your own pending request) |
| `create_deals` | `save_deal`, `backfill_locations`, `review_deal_change` |
| `publish_deals` | `lifecycle`, `bulk_lifecycle` (one named market, owner approval), `archive_drafts` (one draft, with a reason), `publish_drafts` (one draft; also needs `verify_deals`, since it verifies the draft as it publishes it) |
| `verify_deals` | `verify`, `resolve_staff_reminder` |
| `manage_sponsorships` | `sponsorship`, `create_sponsorship`, `update_sponsorship`, `delete_sponsorship` (owner approval) |
| `manage_finance` | `creator_application`, `creator_commission`, `affiliate_payout` (owner approval), `plan_grant`, `referral_correction` (owner approval, needs a reason) |
| `manage_restaurant_photos` | `set_restaurant_photo` (and `POST /api/admin/photo-upload`) |
| `moderate_suggestions` | `suggestion` (rejecting needs a reason), `convert_suggestion` |
| `moderate_feedback` | `feedback`, `report` (changing a completed one also needs `reopen_reports`) |
| `manage_email` | `subscriber`, `accept_waitlist` |
| `manage_users` | `user`, `user_visibility`, `creator_profile`, `setting` (owner approval), `creator_pick`, `invite_restaurant_manager`, `revoke_restaurant_manager`, `set_role_permission` |

Every one of these is written to `audit_log` with the actor, their role, the target, and
action-specific details.

### Actions that need an owner

`OWNER_APPROVAL_ACTIONS` in `app/permissions.ts` lists the destructive and high-risk actions:
`bulk_lifecycle`, `delete_sponsorship`, `affiliate_payout` and `setting`. For these, holding the
permission lets somebody *ask*:

1. Every request must carry `confirmed: true` (the screen's confirmation step); without it the
   server answers 409 `CONFIRMATION_REQUIRED`.
2. From an owner, the action runs at once, audited as usual.
3. From anyone else, the request is checked as if it were about to run, then stored in
   `owner_approvals` with a summary the server writes, and audited as `owner_approval_requested`.
   Nothing changes yet. A person may have at most twenty requests waiting.
4. An owner approves or declines it (`decide_owner_approval`; declining needs a note). Approving
   runs the stored request exactly as it was asked, under the owner's name, and the audit row
   carries the `approvalId`. If it fails, the request is marked failed with the reason.
5. The requester can withdraw a pending request (`cancel_owner_approval`).

### Completed reports stay completed

Once a report or a feedback item is resolved or rejected, changing it again needs
`reopen_reports` (supervisor, admin, owner) on the server, not just a hidden button. Closing a
report or resolving feedback needs a written resolution, reopening either needs a reason, and both
are audited with the previous status. The row records who closed it (`resolved_by`,
`drizzle/0072`), which is what the workspace shows to someone who cannot reopen it.

### The audit log is append-only

`drizzle/0071` adds triggers that abort any `UPDATE` or `DELETE` on `audit_log`, so the record
cannot be changed by the application or by a hand-written query in the D1 console. Inserts are
untouched.

The Audit log section reads it through `GET /api/admin/audit` (search, person, action, record type
and date range, paged by id), so it reaches the whole log rather than the newest 400 rows in the
workspace payload. Neither the route nor the screen offers any way to edit or remove an entry.

---

## 3. Restaurant managers (the `/portal`)

Separate from roles entirely. A row in `restaurant_managers` ties one user to one restaurant:

- Admin invites by email (`invite_restaurant_manager`, needs `manage_users`) → a `pending` row.
- The invitee accepts at `/portal-invite/<id>` → the row becomes `active` and is bound to their
  user id.
- Admin can revoke (`revoke_restaurant_manager`) → the row becomes `revoked`.

An active manager can open `/portal` and, for **their own restaurants only**, run `update_photo`
and `update_deal`. Every portal request re-checks the `restaurant_managers` row for that specific
restaurant; the grant is never cached into the session. A manager with no active row sees the
portal as if they had no access, and the portal link does not appear on their dashboard.

`update_deal` never writes a deal's wording. Pausing a live deal or resuming a paused one applies at
once; a different title, price, schedule, description or terms becomes the deal's one pending row in
`deal_change_requests` (drizzle/0065), and the public listing keeps what it had until staff decide.
Staff with `create_deals` see the queue at the top of Admin → Restaurants and run
`review_deal_change`: approving writes the content onto the deal, rejecting needs a reason, which the
manager then reads in the portal. Both are audited.

Restaurant managers have no admin permissions and cannot reach `/admin`.

---

## 4. The consumer plan (free vs Pro)

Not an access-control role. `isPro()` is `plan === "pro"` and `plan_status` is `active` or
`trialing`, or a staff role. It affects only consumer features, all enforced server-side in `/api/user`:

| | Free | Pro |
| --- | --- | --- |
| Tracked areas | 1 | Unlimited |
| Alert radius | 1–25 km | 1–50 km |
| Alert days / time | One day, 08:00 | Any days, any time |
| Notification history | Last 20 | Last 500, plus CSV export |
| Accent themes | 6 | 8 |

The UI shows Pro-only controls as locked rather than hiding them, but the limits are enforced on
the server — the client's opinion about someone's plan never decides anything.

**Staff get every Pro feature.** Every staff role (`owner`, `admin`, `supervisor`,
`finance_manager`, `developer`, `deal_editor`, `moderator`, `marketing`, `analyst`, and `custom`)
has the Pro column above without a subscription: `hasProAccess` in `app/entitlement.ts`
(`STAFF_PRO_ROLES`, mirrored in `mobile/lib/entitlement.ts`). It is access, not a plan: nothing is
written to `users.plan`, no grant is recorded, Stripe is not involved, and it ends the moment the
role changes. Subscriber counts, affiliate conversions and the billing screens keep reading the real
plan (`isProPlan` / `hasPaidPro`), so the paywall still sells Pro to staff who want to test buying it.
`creator`, `restaurant` and `user` are not staff and are unaffected.

---

## 5. Where enforcement actually happens

| Surface | Check |
| --- | --- |
| `/admin`, `/admin/[section]` pages | `canAdminister()` → `read_admin`, else redirect to `/dashboard`; then `canOpenTab()` for the section |
| `GET /api/admin` | `read_admin`, then each read's own gate (above) |
| `POST /api/admin` | signed in → `read_admin` → same-origin → the action's own permission → confirmation and owner approval where listed |
| `GET /api/admin/export` | `export_data` and the dataset's own read permission |
| `GET /api/admin/audit` | `read_admin`, then the owner or admin role (`isAdminTier`); read-only, 100 entries a page |
| `POST /api/admin/photo-upload` | `manage_restaurant_photos` |
| `GET /api/admin/campaigns` | `manage_campaigns`, `view_analytics` or `manage_finance` |
| `POST /api/admin/campaigns` | `manage_campaigns`, same-origin; every create, edit and status change is audited (`campaign_create`, `campaign_update`) |
| `/portal`, `POST /api/portal` | an `active` `restaurant_managers` row for that restaurant |
| `/creator`, `POST /api/creator` | role `creator` **and** an `active` `creator_profiles` row |
| `/dashboard`, `POST /api/user` | signed in; plan limits applied per action |
| `/api/jobs/*` | a Bearer job secret, not a user session |

Two things are true of every authenticated write: it must pass `requireSameOrigin`, and it is
recorded in `audit_log`.

## Changing the model

- Adding a permission: add it to `ALL_PERMISSIONS` and `PERMISSION_DESCRIPTIONS`, grant it to the
  presets that should have it, map the actions that need it in `ACTION_PERMISSIONS`, and add it to
  this file. The test suite checks the last part.
- Adding an admin action: map it in `ACTION_PERMISSIONS` in the same commit. Until you do, it is
  refused for everyone.
- Adding a workspace role: add it to `WORKSPACE_ROLES` and `WORKSPACE_HOME`, describe it in
  `ROLE_DESCRIPTIONS`, and give it a route that re-checks its own conditions on entry. It needs no
  entry in `ACTION_PERMISSIONS`, because nothing it can do goes through `/api/admin`.
- Do not add a permission check in the client as the only check. The client decides what to show;
  the server decides what is allowed.
