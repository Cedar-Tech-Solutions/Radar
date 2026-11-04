import type { Permission, Role } from "../../permissions";
import type { AdminArea } from "./sections";

// The staff handbook: how each job here works, and what to do when something refuses.
//
// FILED BY ROLE, NOT BY SCREEN. The sidebar is already organized by area — catalog, moderation,
// money, access — and a second copy of that split would only tell somebody where a button is.
// What a person actually needs is the part written for the work they were hired to do, so the
// sections here are roles: deal editors, moderators, supervisors, marketing, finance, analysts,
// developers, admins and owners. Each article still names the area of the workspace it concerns,
// which is what connects the two.
//
// Three sections carry no role. The first is everybody's, because a workspace with several kinds
// of staff in it needs a shared understanding of what is recorded and what should never be
// improvised. The drink rules are everybody's because the alert that sends people to them sits on
// the overview, which every member of staff opens. The last is everybody's for the opposite
// reason: when something looks broken, the person looking at it is whoever happened to be there.
//
// Content as data rather than as JSX, for three reasons. It can be searched without walking a
// rendered tree; tests/admin-handbook.test.mjs can assert that what it claims still matches the
// code it describes — the conditions for publishing a deal, the refusals the server sends back,
// the rates the affiliate program pays — so an article cannot quietly rot into a lie; and an
// article can be filed against a role and a permission, which is what lets the server decide who
// may read it.
//
// WHO READS WHAT. An article is served only to somebody holding its permission (and, for the few
// that name roles, holding one of those roles); the role-less sections go to everybody who can
// open the workspace. The rule is applied by GET /api/admin/handbook, not by the page: this module
// is imported by that route and by the tests, never by a client component, so the text of an
// article somebody may not read never reaches their browser. Somebody covering another queue asks
// for the permission, and the articles about it arrive with it.
//
// WHAT BELONGS HERE. Things a member of staff cannot work out from the screen in front of them:
// why a control is refusing, what a refusal is protecting, where a number comes from, which of
// two similar-looking actions is the reversible one, and the point where the answer stops being
// "click something" and becomes "ask someone". For anything complicated enough that people get it
// wrong — publishing, verifying more than one address, pausing a market, admitting somebody to
// the mailing list, approving an affiliate, comping a subscription — the steps are written out in
// order, including the parts that are not buttons.
//
// WHAT MUST NOT GO HERE. Anything secret. Restricting an article to a permission narrows who reads
// it; it does not make it a vault, and the role-less sections reach every account that can open
// the workspace, including analyst and any custom role with read_admin. So it holds no keys, no
// tokens, no customer data and no personal email addresses — the protected owner account is
// referred to by role.
//
// Pure, with type-only imports, so the tests can load it on its own and the route can run it
// without anything server-only coming along.

export type HandbookKind = "howto" | "runbook" | "reference" | "faq";

export interface HandbookArticle {
  /** Stable anchor and search key. Referenced by tests, so it does not change casually. */
  id: string;
  title: string;
  kind: HandbookKind;
  /**
   * The permission this article is about, or null when it needs none.
   * Drives coverage — every permission has to be explained somewhere — and visibility: only a
   * holder of it is served the article.
   */
  permission: Permission | null;
  /**
   * For the few jobs that answer to a role rather than a permission (deciding an owner approval,
   * reading the audit log): only these roles are served it. Owner always is.
   */
  roles?: readonly Role[];
  /** The part of the workspace it concerns, shown as a chip so a reader knows where to go. */
  area?: AdminArea;
  summary: string;
  /** Ordered steps. A how-to or a runbook has these; a reference usually does not. */
  steps?: string[];
  /** Explanation, one paragraph per entry. */
  body?: string[];
  /** The things that go wrong, and what each one actually means. */
  gotchas?: string[];
}

export interface HandbookSection {
  id: string;
  title: string;
  blurb: string;
  /**
   * The roles this section is written for. Empty means it belongs to everybody, and then every
   * article in it needs no permission. Otherwise it decides order — the reader's own section comes
   * first — while each article's own permission decides whether it is served at all, so a
   * supervisor reads the deal editors' articles because they hold the same grants.
   */
  roles: readonly Role[];
  articles: HandbookArticle[];
}

export const HANDBOOK_KIND_LABELS: Record<HandbookKind, string> = {
  howto: "How to",
  runbook: "If this happens",
  reference: "Reference",
  faq: "Question",
};

export const HANDBOOK: HandbookSection[] = [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "everyone",
    title: "Everyone",
    blurb: "What this workspace is, how it decides what you can touch, and the short list of things nobody should improvise.",
    roles: [],
    articles: [
      {
        id: "what-this-is",
        title: "What this workspace is, and who else is in it",
        kind: "reference",
        permission: null,
        summary: "One workspace, several jobs. What you can see is the part of it that answers to you.",
        body: [
          "This is Radar's staff workspace. The catalog is edited here, the public queues are worked here, the mailing list is run here and accounts are looked after here. Everybody who works on Radar uses the same one — what differs between two people is which parts of it are theirs.",
          "It is not a product per team, and the tabs down the left are the whole of it. Each tab is its own page, so any of them can be bookmarked or pasted to a colleague, and Ctrl+K — Command+K on a Mac — opens a search box that jumps straight to one by name.",
          "Three other workspaces exist and are not this one. A restaurant manages its own listings in the restaurant portal, a creator works in the creator workspace, and an ordinary signed-in visitor has an account dashboard. Those are separate places with their own rules, and nobody standing in one of them can reach this one.",
          "The Staff directory lists everybody who works in this workspace, with their role and how to reach them. It is the place to find out who owns a queue before asking around.",
        ],
        gotchas: [
          "This handbook shows you the articles for the work your role includes, plus the sections everybody reads. If you are covering somebody's queue, ask an owner or admin for the permission it needs — the articles about that work appear with it, the next time you open this page.",
          "The workspace is not the website. What you change here reaches the public site on its own schedule — read 'I changed a deal and the site still shows the old one' before promising anybody a time.",
        ],
      },
      {
        id: "what-you-can-do",
        title: "Why a control is missing, grayed out, or refusing",
        kind: "reference",
        permission: null,
        summary: "Almost always a permission rather than a fault — and the refusals that are not are usually protecting something.",
        body: [
          "Every write in this workspace is filed against exactly one permission, and the server checks it again on arrival. The screen hides what you cannot do and the server would refuse it even if the button were forced, so a control you cannot see is one your role was not given rather than one that is broken.",
          "Permissions come from your role. One person at a time can instead be given a custom set of their own, which is how somebody gets a single extra permission without being promoted into a wider role. Your own tab list is built from whatever you hold.",
          "A control you can see that refuses when you use it is a different thing, and the message says which. Those refusals are almost all guards rather than errors: a deal that is not ready to publish, a drink offer the rules do not allow, a commission a payout has already claimed, a role change or a rejection with no reason recorded, a completed report only a supervisor can reopen. Each one is written up in the section for the job it belongs to.",
          "A few actions are not refused but held: they go to an owner for approval instead of running. That is not an error either — see 'Why something says it was sent to an owner'.",
          "Two account types never see this workspace at all. A creator account opens the creator workspace and a restaurant account opens the restaurant portal; neither can be given a permission here, because both resolve to an empty permission set in code rather than from a table. Moving somebody to one of those roles takes their staff access away entirely.",
        ],
        gotchas: [
          "Seeing a tab is not being able to act in it. Read access shows you the numbers and every action underneath still needs its own permission — an analyst can see almost everything and change nothing.",
          "If you need something you cannot do, ask for it rather than working around it. A permission takes an owner seconds to grant and leaves a record; a borrowed login leaves the audit trail naming the wrong person for everything you then do.",
        ],
      },
      {
        id: "audit-log",
        title: "Everything you do is recorded, and that is useful to you",
        kind: "reference",
        permission: null,
        area: "access",
        summary: "Who changed what, when, and why. The first place to look when a record is not what you expected.",
        body: [
          "Every write lands in the audit log with the account that made it, the role it held at the time, the record it touched and the details worth keeping — which deal, which handle, which amount, which role somebody moved from and to. It is not a surveillance feature; it is how you answer \"who paused this, and when\" without asking four people.",
          "Some actions will not proceed without a reason in writing, and the reason is stored with the entry rather than shown once and thrown away. Changing somebody's role, rejecting a suggestion, archiving a draft, closing or reopening a report, refusing a commission and granting a subscription all ask for one. Write it for the person who reads it in six months, not for the form.",
          "The log is append-only. Once an entry is written, nobody can edit or delete it — not from this workspace, and not by a hand-written query against the database either. A mistake is corrected by a new action, which gets its own entry, never by tidying the old one.",
          "When something looks wrong, read the log before assuming a fault. Most surprises are an action somebody took deliberately, and the log says so in one line.",
        ],
        gotchas: [
          "The log itself is visible to owners and admins. If you are not one and you need an entry explained, ask — do not reconstruct it from memory.",
          "Downloading data is recorded too. Every export leaves an entry naming the dataset, the filters and how many rows went out.",
        ],
      },
      {
        id: "owner-approvals",
        title: "Why something says it was sent to an owner",
        kind: "reference",
        permission: null,
        area: "admin",
        summary: "Five high-risk actions only an owner can carry out. Anyone else who holds the permission can ask, and the request waits.",
        body: [
          "Pausing or archiving a whole market, deleting a sponsorship contract, paying an affiliate, correcting the referral code on an account, and flipping an operator switch can each do damage that is hard to undo. Holding the permission for one of them lets you ask; only an owner can make it happen. Admin access is not owner access, so an admin's request waits like anyone else's.",
          "Every one of these opens a confirmation step first. Confirm it, and if you are not an owner the screen says the request was sent to an owner for approval. Nothing has changed yet: the market is still live, the money has not moved, the switch is where it was. The request is stored exactly as you asked it, with your reason, and an entry in the audit log says you asked.",
          "An owner reads it in Admin → Approvals and approves or declines it. Approving runs your request exactly as it was asked, under the owner's name, and the audit entry points back to your request. Declining needs a note, which you can read beside the request. If an approved request fails when it runs — the market had no deals left, the affiliate's balance had already been paid — it is marked failed with the reason.",
        ],
        gotchas: [
          "'Sent to an owner' is not 'done'. Do not tell a restaurant, an affiliate or a colleague it has happened until the request shows as approved.",
          "You can withdraw your own request while it is still waiting. You cannot withdraw anybody else's, and nobody can withdraw one that has already been decided.",
          "You can have at most twenty requests waiting at once. If you hit that, withdraw the ones that no longer matter rather than asking again.",
          "A request that could never work — a market with no deals, a setting that does not exist — is refused while you are still looking at it, not queued for an owner to discover days later.",
          "If it is urgent, ask an owner directly as well. The queue is the record, not the alarm.",
        ],
      },
      {
        id: "getting-an-export",
        title: "Getting a spreadsheet of workspace data",
        kind: "howto",
        permission: null,
        area: "admin",
        summary: "There is no download button in your sections on purpose. Exports are made on the server by a developer or an owner, and every one is recorded.",
        body: [
          "Exports used to be built in the browser from whatever the page held, which meant anybody who could see a list could walk away with all of it. Now a CSV is only ever made on the server, only by the developer role or an owner, and each one leaves an audit entry naming the dataset, the filters and the number of rows.",
        ],
        steps: [
          "Decide what you actually need. A filtered list — one city, one status — is quicker to make, smaller to send around, and less of a liability sitting in somebody's downloads folder.",
          "Ask a developer, or an owner. Name the dataset (deals, restaurants, users, mailing-list subscribers or the audit log), any filters (for deals: status, country, province or state, city) and what it is for.",
          "Expect people data to need an owner. A developer can export deals and restaurants; users, subscribers and the audit log also need the permission to read that data in the first place, which in practice means the owner makes those.",
          "Treat the file like the data it holds. Do not forward a list of people's email addresses outside the team, and delete it when the job it was for is done.",
        ],
        gotchas: [
          "Each file is capped at 2,000 rows. A request for 'everything' may come back as a request for a narrower filter.",
          "Reading a number off a screen does not need an export. Most questions are answered by the counts and filters already in the workspace.",
        ],
      },
      {
        id: "covering-someone",
        title: "Covering somebody else's work",
        kind: "howto",
        permission: null,
        summary: "Holidays, illness, a busy week. How to pick up a queue that is not normally yours.",
        steps: [
          "Check what you actually hold. If the controls are visible the permission is yours; if they are not, that is the answer and no amount of clicking changes it.",
          "Ask an owner for a custom permission set rather than a role promotion if you are short one thing. Custom is per person, so it does not quietly widen everybody who shares that role, and it is as easy to take back.",
          "Read their role's articles here once you have the permission — they appear in this handbook with it. Every queue has a rule that is not obvious from its screen: what converting a suggestion actually creates, why a closed report cannot simply be reopened, why an email did not go out.",
          "Work under your own account, always. The audit trail names whoever is signed in, so borrowing a login makes every entry you leave wrong, including the ones you get right.",
          "Leave the queue readable. Resolve with a resolution note, reject with a reason, and do not leave items half-edited — the person coming back cannot tell the difference between work in progress and work abandoned.",
        ],
        gotchas: [
          "Handing work back matters as much as taking it on. Say what you did and what you deliberately left, especially anything you paused.",
        ],
      },
      {
        id: "who-to-ask",
        title: "When to stop and ask",
        kind: "reference",
        permission: null,
        summary: "The short list of things that should never be improvised, whoever you are.",
        body: [
          "Most of this workspace is safely reversible. A paused deal can be unpaused, a rejected suggestion can be converted later, a hidden account can be unhidden. A few things are not, and each of them is worth a second opinion rather than a confident guess — including when you are the person with the permission to do it.",
        ],
        gotchas: [
          "Anything that sends money. A payout creates a real Stripe transfer out of Radar's balance and cannot be called back from here.",
          "Anything that deletes rather than hides. Pausing, hiding, archiving and revoking are all reversible; deleting an account and its data is not.",
          "Anything that affects a whole market at once. Pausing a city takes every offer in it out of public view, there is no bulk way back, and it needs an owner's approval for exactly that reason.",
          "Anything that changes the alcohol filter or the app's age rating. The filter keeps drink deals away from readers who have not said they may see them; it is a commitment, not an editorial preference.",
          "Anything that would loosen the drink-advertising rules. They follow provincial and state law; a deal the rules refuse is changed or pulled, never pushed through.",
          "Anything you are doing because a message asked you to, where access or money is involved. Confirm through a channel you already trust before acting — a convincing email is the cheapest thing in the world to send.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The approved summary of the drink-advertising rules and app/drink-rules.ts, for staff who have
  // no access to either. The overview's drink-rule alert links here (/admin/help#drink-rules), so
  // the section id is an anchor other code depends on. Change this, the rules research and that
  // module together.
  {
    id: "drink-rules",
    title: "Drink rules",
    blurb: "What Radar may say about drink prices, province by province and state by state — what the alert means and what to do when a deal breaks a rule.",
    roles: [],
    articles: [
      {
        id: "drink-rules-what",
        title: "What cannot be advertised, and where",
        kind: "reference",
        permission: null,
        area: "catalog",
        summary: "A short list of drink offers Radar never prints anywhere, the states where happy hour itself is banned, and the provinces with minimum prices.",
        body: [
          "Most of Radar's catalog is happy hour, and drink prices are regulated everywhere Radar lists them. The rules bind the bar rather than Radar, but a listing that describes something the bar is not allowed to do is evidence against it — and a few rules reach anybody who advertises. So every deal that mentions alcohol (the same test the app's food-only filter uses) is checked against the rules of every province or state it has a branch in.",
          "Never printed anywhere: free drinks; unlimited, bottomless, all-you-can-drink or open-bar offers; two-for-one, buy-one-get-one or cheaper-second-drink pricing; drinking games and pub crawls; ladies'-night drink prices. These are banned in most of the places Radar lists, so they are blocked everywhere.",
          "Happy hour is banned outright in Massachusetts, Rhode Island, Vermont, North Carolina, Utah and Alaska. In those states a drink's price may only change for a whole business day or a whole week, so a happy hour cannot be listed there at all. Rhode Island and Utah also ban the words: a food-only 'happy hour' there has to be renamed.",
          "Canadian provinces set a minimum price per drink. A drink price below the minimum is blocked. It is compared against the smallest serving its word implies — 12 oz for a beer, 5 oz for a glass of wine, 1 oz for spirits — so a '$4 pint' is never held to a rule it does not break. Alberta's minimums changed and were reversed in June 2026, so they are not enforced until the current figures are confirmed.",
          "In Quebec a drink offer cannot be worded as a discount: no 'half price', no '% off', no 'rabais', no '$2 off'. Print the 5 à 7 price itself.",
          "Some limits depend on facts the copy cannot settle, so they are flagged for a person to check rather than blocked: a drink price in a happy-hour-ban state that may hold all day; a happy hour running past a state's cutoff or longer than its daily cap (Indiana, Illinois and Pennsylvania allow four hours a day; Texas, Virginia, Ohio, Alabama and South Carolina have cutoffs of their own); a British Columbia drink price whose source is not the venue's own site; a US national chain's happy hour whose branches include a ban state.",
          "The legal drinking age is 18 in Quebec, Alberta and Manitoba, 19 in the rest of Canada and 21 in every US state. Every drink deal's public page carries one line saying the venue's prices follow local liquor laws, the legal age there, and to drink responsibly. You do not need to add it.",
        ],
        gotchas: [
          "These rules are researched summaries, not legal advice. If a restaurant or anybody else disputes one, do not argue it — raise it with an owner.",
          "The check reads the words on the card, and the law reads the offer. Rewording a bottomless brunch until the check stops complaining does not make it legal; it makes it a misleading listing as well.",
        ],
      },
      {
        id: "drink-rules-alert",
        title: "What the drink-rule alert means",
        kind: "reference",
        permission: null,
        area: "catalog",
        summary: "'Must change' stops a deal going live; 'Check' never does. Where each one appears, and why a live deal can be on the list at all.",
        body: [
          "Every issue has one of two labels. Must change means the copy shows something clearly not allowed where the deal runs, and it blocks: publishing refuses, draft review will not publish the draft, and approving a restaurant manager's edit that introduces it is refused. Check means something depends on a fact the copy cannot settle — the venue's real hours, whether a price holds all day — and it is shown to staff without stopping anything.",
          "Each issue names the place it applies to and what to change, in plain words. A chain with branches in several provinces or states can collect an issue from each of them.",
          "The overview's 'Live drink deals to fix' list shows every live deal with an issue, the ones that must change first. Publishing refuses the clear cases now, so most of what is on that list went live before a rule existed or was edited afterwards. A deal leaves the list on its own once its copy is fixed or it is taken down.",
          "Saving a deal in the editor returns any issue as the save's warning. If a live deal is edited into a Must change issue, it is moved back to draft rather than left live and in breach.",
        ],
        gotchas: [
          "A live deal that suddenly turned into a draft after an edit is usually this, not a fault. The save's warning said why.",
          "An empty list is the goal, not a sign that the check is off. The list hides itself when nothing is wrong.",
        ],
      },
      {
        id: "drink-rules-fix",
        title: "A drink deal is flagged: what to do",
        kind: "runbook",
        permission: null,
        area: "catalog",
        summary: "Fix the wording when only the wording is wrong; pause the deal when the offer itself is not allowed where it runs.",
        body: [
          "Editing and pausing deals needs the deal permissions. If you do not hold them, tell whoever runs the catalog which deal is flagged and what the issue says — that is the whole job.",
        ],
        steps: [
          "Read the issue. It names the province or state and the thing to change.",
          "Open the deal's source and decide which kind of problem it is: the wording (a Quebec discount, a food-only 'happy hour' in Rhode Island or Utah, a price written as a saving) or the offer itself (bottomless drinks, two-for-one, a happy hour in a ban state).",
          "If it is the wording, rewrite it to state the offer accurately within the rule — print the actual price instead of the discount, rename the food special — then save. The issue clears when the copy no longer breaks the rule.",
          "If the offer itself is not allowed there, pause the deal. Do not invent a different offer to fit; Radar lists what the restaurant actually runs, or nothing.",
          "If it is a chain and only some of its branches are in the place with the rule, do not split or trim the deal on your own. Pause it and ask, because the branches it lists are a claim about where the offer runs.",
          "For a Check, compare with the source: does the price hold all day, does the happy hour really end when the card says? If it holds up, note what you checked when you verify the deal. If you cannot tell, pause it and ask.",
          "For a suggestion or a restaurant edit that would break a rule, reject it with the drink-rules reason. The submitter reads it.",
        ],
        gotchas: [
          "Pausing is reversible and leaves the deal's history intact. When unsure, pause rather than leave a Must change issue live.",
          "Do not remove the word 'drink' or the price just to stop the alert. A listing that hides what it is offering misleads the reader and does nothing about the law.",
        ],
      },
      {
        id: "drink-rules-questions",
        title: "When somebody questions a rule",
        kind: "faq",
        permission: null,
        area: "catalog",
        summary: "What to do when a restaurant, a reporter or a regulator asks about one of the drink rules.",
        body: [
          "The rules are Radar's reading of provincial and state law, applied the same way to every deal. They change when the owners change them, not case by case.",
        ],
        gotchas: [
          "No question about a rule is yours to settle on the spot. If a restaurant, a reporter or a regulator raises one, note who and what, and pass it to an owner.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "deal-editors",
    title: "Deal editors",
    blurb: "The catalog: finding offers, getting them live, keeping them true, and taking them down when they stop being true.",
    roles: ["deal_editor"],
    articles: [
      {
        id: "publish-a-deal",
        title: "Add a deal and get it live",
        kind: "howto",
        permission: "create_deals",
        area: "catalog",
        summary: "The full path from an offer you have found to a page a visitor can act on, including the four things publishing checks.",
        body: [
          "A deal is not one record. It is an offer, attached to a restaurant, at one or more of that restaurant's addresses, on a schedule, with a source that proves it exists. Publishing checks that those parts are all present, which is why it refuses more often than people expect — each refusal names a piece that is missing rather than a mistake you made.",
        ],
        steps: [
          "Search the catalog for the restaurant before you create anything. A second copy of a restaurant that already exists splits its photos, its addresses and its deals between two records, and putting them back together afterwards is manual work nobody enjoys.",
          "Create the deal and attach it to that restaurant. Give it a primary address with a city and a postal code: the postal code is what gets turned into coordinates, and a deal with no coordinates cannot be found by anybody searching near them.",
          "Write the offer itself. The title is what appears on the card. Say what a person actually gets, put the price in the restaurant's own words, and put every condition that changes whether it is a good deal — a required drink, a minimum spend, dine-in only, one per table — into the restrictions rather than leaving them to be discovered at the till.",
          "Set the schedule: the days and the hours it runs, in the restaurant's own time. The schedule is what the site uses to decide whether to show the deal as on right now, so an approximate one produces a card that is wrong twice a day.",
          "Add every address the offer runs at, not just the first. A chain promotion at six branches is six offer locations, and a visitor's radius search matches against those addresses rather than against the restaurant in general.",
          "Paste the source URL. This is the evidence the offer exists and the thing the next person will re-check it against, so link the page that states the offer rather than the restaurant's home page.",
          "Save it as a draft and read the card back as though you had never seen it. Most of the errors that reach the public site are visible at this point.",
          "Verify it against the source — see the verification article, especially if the deal runs at more than one address.",
          "Set the status to Live. If it refuses, the message names the missing piece; fix that and try again.",
        ],
        gotchas: [
          "Publishing refuses until four things are true: at least one confirmed offer location, a source URL, an eligible schedule, and a verification. The message names whichever is missing — it is a checklist, not a failure.",
          "A location you typed is not yet a confirmed one. Confirming happens when somebody verifies the deal against its source, which is why verification comes before publishing rather than after it.",
          "A drink offer that breaks the advertising rules where it runs is refused too, with the rule named. See the Drink rules section: fix the wording, or do not publish the offer.",
          "Scheduled is for an offer that starts later. It will not appear until its publish date passes, however finished it looks.",
          "The price field is deliberately free text, because most real offers are a range, a combo, or 'half price'. Write it the way the restaurant writes it rather than forcing it into a number.",
        ],
      },
      {
        id: "lifecycle",
        title: "What each deal status means",
        kind: "reference",
        permission: "publish_deals",
        area: "catalog",
        summary: "Draft, scheduled, live, paused, expired, archived — which of them a visitor can see, and which happen on their own.",
        body: [
          "A visitor sees a deal only when it is live, active, not deleted and past its publish date. Everything else is invisible to the public whatever else is true about it.",
          "Draft is unfinished work. Scheduled is finished work waiting for a date. Live is public. Paused is deliberately taken down and expected back, which is the usual choice when a restaurant stops running something for a while. Expired means its end date has passed. Archived is done with, kept for the record rather than deleted.",
          "Expiry happens on its own: an hourly job moves a live deal to expired two days after its end date. The two days are deliberate slack, because an offer advertised as ending 'end of March' is usually still running on the first.",
        ],
        gotchas: [
          "Pausing is the reversible one, and it is the right reach when you are unsure. An archived deal takes more work to bring back than a paused one.",
          "A deal going quiet without anyone touching it is almost always automatic expiry. Check its end date before looking for a fault.",
          "Ended deals have a tab of their own, so a market that has gone quiet can be read in one place rather than filtered out of the main list.",
          "Market coverage is its own section: deal counts by country, then province or state, then city, then postal area, with how many are live, drafts or stale. It is where to see a market thinning out before anybody complains.",
        ],
      },
      {
        id: "verification",
        title: "Verify a deal, including one that runs at several addresses",
        kind: "howto",
        permission: "verify_deals",
        area: "catalog",
        summary: "What the Checked badge promises, how to confirm more than one address at once, and what makes a deal lose it.",
        body: [
          "Verifying means you personally compared the deal with its source and it matched. The site turns that into a Checked badge; a deal without one reads as Re-checking, which is an honest \"we are not sure right now\" rather than an accusation.",
          "Verifying also confirms addresses, which is the part people miss. A deal cannot be published until at least one of its offer locations is confirmed, and confirming is something verification does rather than something you tick.",
        ],
        steps: [
          "Open the source and read what it says today, not what we wrote when the deal was added.",
          "Decide which addresses the source actually covers. By default verifying confirms one — the deal's primary location — and leaves the rest as they were.",
          "Use the confirm-every-address option only when the source really does cover them all. The control names the number it is about to confirm, deliberately: confirming eight addresses from a page that lists three is the single mistake this is designed to make hard.",
          "Add a note if anything was ambiguous — a time that reads two ways, a branch the page does not mention. The note is kept with the verification and is what the next person reads before re-checking.",
          "Save. The deal is stamped verified, and each address you confirmed is stamped with the source URL and the time.",
        ],
        gotchas: [
          "Verification needs a source URL first. Without one the action refuses outright, because there is nothing to have checked against.",
          "Verify against the source, never against our own copy. Re-reading what we typed confirms nothing.",
          "Verification goes stale by itself after thirty days. That is not a claim the deal is wrong — it is the site declining to keep promising something nobody has looked at in a month. The overview tab counts stale and unverified deals so the queue is visible rather than something you have to go looking for.",
          "If the source has gone — page down, post deleted — the deal is no longer verifiable. Pause it rather than verifying it from memory.",
        ],
      },
      {
        id: "draft-review",
        title: "Review drafts one at a time",
        kind: "howto",
        permission: "publish_deals",
        area: "catalog",
        summary: "How the Draft review tab turns a research draft into a live deal or archives it — one draft per decision — and what it refuses.",
        body: [
          "Research leaves its finds as drafts, each with a note quoting what the source said. Draft review is a list of drafts beside a detail pane: pick one from the list and the pane puts its fields next to that note, so the check is reading across one screen rather than opening the editor several times per deal.",
          "The pane offers three decisions for the draft in front of you: Verify & publish, Archive, or Edit, which opens it in the deal editor. Verify & publish does what the editor's verify and Live buttons do together: it records a check against the source, confirms the deal's primary branch, saves the hours it read from the schedule line, and puts the deal live. It needs both the publishing and the verifying grant.",
          "Every decision is about one draft. Publishing a column of drafts together made it easy to put live something nobody had actually read, so the screen decides them one at a time and the server refuses more than one draft per decision whatever is sent to it.",
        ],
        steps: [
          "Narrow the list to a place — a city, or a province or state — so the drafts you read in a row share a time zone and a context.",
          "Select one draft in the list. Open its source from the detail pane and compare it with the marked words in the note and with the fields beside them. The note says whether the source was the restaurant's own page.",
          "Read the line under the schedule: those are the days and hours that will be saved. If they are wrong, choose Edit and fix them in the editor instead of publishing from here.",
          "Read any drink-rule issue in the pane. A Must change issue stops the draft being published until its wording is fixed in the editor.",
          "If it holds up, choose Verify & publish. If something is missing, the pane says what, and nothing is changed.",
          "If it does not hold up, choose Archive and write why. The reason is required and goes into the audit log against the draft.",
          "Move on to the next draft in the list. Decided drafts leave it.",
        ],
        gotchas: [
          "A draft whose hours cannot be read from its schedule, or with no source or branch, cannot be published from here. The pane says which; fix it in the editor.",
          "Publishing confirms only the deal's primary branch. A draft listed at several addresses says so in the pane; confirm the others in the editor.",
          "The deal gets the same verify and lifecycle audit entries the single buttons write, marked as coming from draft review.",
          "If somebody else published or archived the draft while you were reading it, yours is left alone and the screen says so.",
        ],
      },
      {
        id: "what-counts",
        title: "What counts as a Radar deal",
        kind: "reference",
        permission: "create_deals",
        area: "catalog",
        summary: "The editorial line: what goes in the catalog, and how to write it so nobody is surprised at the till.",
        body: [
          "A Radar deal is an offer a person can turn up and get, on terms we have written down accurately. The test is whether somebody who read the card and then walked in would find what they expected.",
          "Disclose the conditions that change whether it is a good deal. A required drink purchase, a minimum spend, dine-in only, one per table — those belong in the deal, not in the small print of somebody's evening.",
          "Do not re-label an offer into something it is not. A happy hour is a happy hour and not a dinner special; a bundle price is not a discount on each item inside it.",
        ],
        gotchas: [
          "A price that only applies with a drink purchase is not the price. Say the condition.",
          "If the offer cannot be described accurately in the space available, that is a sign it is not a listing — not a sign to shorten the truth.",
        ],
      },
      {
        id: "alcohol-filter",
        title: "The alcohol filter is deliberately over-eager",
        kind: "reference",
        permission: "create_deals",
        area: "catalog",
        summary: "Why the food-only view is deliberately over-eager, and why the rules behind it are not a tuning knob.",
        body: [
          "Radar's catalog is mostly happy hours, and almost every happy hour references drinks. The food-only filter is the in-app control that keeps that half of the catalog away from readers who have not said they may see drinks: with it on, a minor never meets it.",
          "So the filter is deliberately over-eager. Hiding a wing special from somebody who would have enjoyed it costs far less than showing a cocktail listing to a thirteen-year-old. Happy hour is treated as alcohol categorically, whether or not a particular deal names a drink.",
          "It runs when the page is built rather than from a column somebody ticks, so a deal added today is classified without anyone having to remember.",
        ],
        gotchas: [
          "The rules behind the filter are set by the owners. Raise a change rather than adjusting it.",
          "A food-only deal being hidden is the filter working as designed, not a bug to fix on the spot. Note it and raise it.",
        ],
      },
      {
        id: "restaurant-photos",
        title: "Restaurant photos",
        kind: "howto",
        permission: "manage_restaurant_photos",
        area: "catalog",
        summary: "Where a card's picture comes from, and what to do when it is wrong or missing.",
        body: [
          "A photo belongs to the restaurant rather than to the deal, so fixing one fixes every card that restaurant appears on. The Restaurants tab badges how many are still missing one, which is the queue to work through.",
          "Set it either by pasting an image address or by uploading a file. A pasted address has to be a real image URL — anything else is refused rather than saved and left showing a broken card. Clearing the field removes the photo entirely.",
          "Pick something that shows the place or its food. A logo on a white background is worse than no photo at all, because at card size it reads as an image that failed to load.",
        ],
        gotchas: [
          "A photo that looks right here and wrong on the site is usually the delay described in 'I changed a deal and the site still shows the old one', not the wrong file.",
        ],
      },
      {
        id: "deal-is-wrong",
        title: "A deal is wrong and somebody has noticed",
        kind: "runbook",
        permission: "publish_deals",
        area: "catalog",
        summary: "A report, a complaint, or a restaurant telling us the offer has changed.",
        steps: [
          "Pause the deal first, before investigating. An offer that is wrong should stop being shown while you work out what it should say, and pausing is one click and reversible.",
          "Open the source. Most of the time the restaurant changed the offer and the source already says so.",
          "If the offer still exists in a different form, edit it to match, verify it against the source again, and set it back to live.",
          "If the offer is gone, give it an end date or archive it. Do not leave it paused and unexplained — the next person cannot tell that apart from an edit somebody abandoned halfway.",
          "If it arrived as an accuracy report, resolve the report with a note saying what you found, so the queue reflects reality rather than effort.",
        ],
        gotchas: [
          "Correcting the deal here does not immediately correct its own page on the site. This is the one case where that delay really matters, so say so plainly if a restaurant or a reporter is waiting on it.",
        ],
      },
      {
        id: "pause-a-market",
        title: "Pause an entire market",
        kind: "runbook",
        permission: "publish_deals",
        area: "catalog",
        summary: "Taking every offer in one named city out of public view at once. High impact, owner-approved, and there is no bulk way back.",
        body: [
          "This exists for the situations where deal-by-deal is not fast enough: an import that went wrong across a whole city, a market Radar is pulling out of, a legal problem that covers everything in one place. It is the largest single action in the workspace and it is deliberately awkward to trigger.",
          "It always names one market. There is no control that pauses every city at once — that option used to exist and was removed, and the server refuses it even if asked.",
        ],
        steps: [
          "Be certain about the scope first. It affects every deal in the chosen city whatever its current status.",
          "Set the deal inventory's place filter to that one city. The pause-this-market action is only offered while the filter names a single city — never for a province, a country or no filter at all. Nothing publishes in bulk.",
          "Write the reason and type the confirmation phrase exactly as the dialog shows it, with the market's name. Both are required; the phrase check is exact, including capitals and spelling, and the button stays disabled until it matches.",
          "Confirm. If you are an owner it applies immediately. Anyone else's request goes to an owner and nothing changes until one approves it — the screen says so. See 'Why something says it was sent to an owner'.",
          "Tell somebody straight away, and an owner if you are waiting on one. A market going dark is visible to every visitor in it, and to every restaurant in it.",
        ],
        gotchas: [
          "There is no bulk way back. Returning a market to live is done deal by deal, on purpose — an action this large should not have an equally large undo that somebody reaches for without thinking.",
          "The confirmation phrase is not a formality. It is the difference between a deliberate decision and a mis-click on a row you were scrolling past.",
          "It reaches drafts and archived deals too, not only the live ones, so the market's state afterwards is not simply 'what was live is now paused'.",
          "An owner approves the request exactly as you asked it. If the city's name was wrong, withdraw the request and ask again rather than hoping the owner notices.",
        ],
      },
      {
        id: "deal-without-locations",
        title: "A deal has an address but no offer locations",
        kind: "runbook",
        permission: "create_deals",
        area: "catalog",
        summary: "An imported deal that can never publish, because the address written on it was never turned into a real location.",
        body: [
          "A batch of deals was imported straight into the catalog rather than created here. They carry an address, a city and a postal code as plain text on the deal itself, but they were never linked to a restaurant record or an address record — so the locations editor has nothing to show, and the deal can never satisfy the confirmed-location requirement however many times it is verified.",
          "There is a repair for this that takes each such deal, finds or creates the restaurant it names, finds or creates the address, turns the postal code into coordinates and links them together. It uses only what is already stored on the deal, and it touches nothing else — not the status, not the schedule, not the wording.",
        ],
        steps: [
          "Recognize it: the deal shows an address in its own fields, the offer-locations list is empty, and publishing refuses on the location however much else you fix.",
          "Do not work around it by retyping the offer as a new deal. That leaves two records for one offer and the original still broken.",
          "Ask for the location repair to be run. It is safe to run more than once — deals that are already linked are skipped, so a second run does nothing.",
          "Afterwards, open the deal and check the address it was given. The repair uses what the deal already said, so a deal imported with a wrong address now has a correctly-linked wrong address.",
          "Confirm the location by verifying the deal against its source, then publish as normal.",
        ],
        gotchas: [
          "A postal code that cannot be placed leaves the location without precise coordinates. The deal will publish, but it will not be found by somebody searching near that address — worth checking on anything imported.",
        ],
      },
      {
        id: "restaurant-edits",
        title: "Review a restaurant's edit to its deal",
        kind: "howto",
        permission: "create_deals",
        area: "catalog",
        summary: "Approving or turning down the wording a restaurant manager changed in the portal.",
        body: [
          "A manager can pause and resume their own live deals straight away, but a change to the title, price, schedule, description or terms waits for staff. The public listing keeps what it says until somebody approves the change here.",
        ],
        steps: [
          "Open the Restaurants tab. Edits waiting for review sit at the top, oldest first, and the tab's badge counts them.",
          "Each one shows only the fields that would change: what the listing says now, struck through, beside what the restaurant asked for.",
          "Check the change against the restaurant's own menu or site, the same as any other source, then approve or reject.",
          "Rejecting asks for a reason. The manager reads it in the portal, so write it for them.",
        ],
        gotchas: [
          "Approving a schedule change updates the schedule text only. Open the deal and make its schedule windows match, because those decide whether it shows as available now.",
          "If the card says the deal was edited after the change was made, approving replaces those edits. Reject and say why if they should stand.",
          "Approving accepts the wording; it does not re-verify the deal. Verify it separately if you checked the source.",
        ],
      },
      {
        id: "staff-reminders",
        title: "Work the daily renew-or-confirm reminders",
        kind: "howto",
        permission: "verify_deals",
        area: "catalog",
        summary: "The reminders at the top of the overview: deals ending soon, checks about to lapse, and new drafts to review.",
        body: [
          "Every day at noon Eastern, Radar opens a reminder for each live deal ending within a week and each verified deal whose last check is about to pass 30 days. A new research draft gets one too. They sit at the top of the overview, and the Overview link's badge counts them.",
          "A reminder closes itself once the deal moves on: a new end date, a fresh check, publishing or archiving a draft, or the deal ending or being deleted. Nobody has to tidy them up.",
        ],
        steps: [
          "Open the source first, the same as any other check.",
          "Ending soon: if the restaurant is still running it, open the deal and set the new end date (or clear it). If it really ends then, choose End date is right.",
          "Check about to lapse: if the source still says the same, choose Still right. If not, edit the deal.",
          "New draft from research: review it like any draft, then publish or archive it. Done closes the reminder and leaves the draft as it is.",
        ],
        gotchas: [
          "A reminder marked done is not opened again for the same end date or the same check. A new end date gets a new reminder when it, too, comes within a week.",
          "Deals whose check is already overdue are in the review queue below, ranked by how many people use them, not in the reminders.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "moderators",
    title: "Moderators",
    blurb: "The queues where the work arrives from outside: public suggestions, accuracy reports and tester feedback.",
    roles: ["moderator"],
    articles: [
      {
        id: "suggestions",
        title: "Work the suggestions queue",
        kind: "howto",
        permission: "moderate_suggestions",
        area: "moderation",
        summary: "Turning something a visitor sent in into a real deal, and what converting does and does not give you.",
        steps: [
          "Open the suggestion's inspect view before deciding anything, and read it against the source it names. A suggestion with nothing checkable behind it is not ready however plausible it sounds — leave it pending rather than converting it on faith.",
          "Search the catalog before converting. Duplicates are the commonest thing in this queue, and a second copy of an existing deal splits its history and its verification.",
          "Convert it if it holds up. That creates a draft deal carrying the restaurant name, the offer text and the schedule the suggester typed, and marks the suggestion approved.",
          "Fill in what converting could not know. The new deal arrives with placeholders where the facts should be — the city and the address both say 'Needs assignment', the price says 'Add pricing', the category is a generic food deal and there is no source URL at all.",
          "Finish it like any other deal: real address, real schedule, source, verification, then live. Converting has published nothing.",
          "Reject it if it does not hold up, choosing the reason that fits. A reason is required — see 'Rejecting suggestions' — because somebody took the trouble to send it in and the reason is read by a person.",
        ],
        gotchas: [
          "Converting the same suggestion twice does not make a second deal — the second attempt quietly does nothing — but it does not undo any editing you have already done to the first either.",
          "A suggestion for a restaurant in a city Radar does not cover yet is not automatically a rejection. Check whether the city is one we list before turning it down.",
          "An approved suggestion whose deal was never finished is invisible to everybody: the queue looks clean and nothing was published. Finish the deal, or put the suggestion back.",
        ],
      },
      {
        id: "reports",
        title: "Accuracy reports",
        kind: "howto",
        permission: "moderate_feedback",
        area: "moderation",
        summary: "Somebody turned up and the deal was not there. The most valuable signal Radar gets.",
        body: [
          "An accuracy report comes from somebody who acted on the site and was let down, which makes one report enough to go and look. Do not wait for a pattern.",
          "The fix almost always belongs to the deal rather than to the report. Pause or correct the deal first, then close the report — a report is a record of what happened, not the thing that was wrong.",
          "While a report that the deal has ended or is wrong is open or reviewing, the public sees the deal as Re-checking and it ranks below deals nobody has questioned. It stays listed. Resolving or rejecting the report ends that on the next search refresh, so a mistaken report should be rejected promptly rather than left open.",
        ],
        steps: [
          "Open the deal the report names and check it against its source.",
          "Move the report to reviewing if you are going to be a while, so nobody else starts the same investigation.",
          "Fix the deal — correct it and re-verify, or pause it, or end it. That is the part the public sees.",
          "Resolve the report and write the resolution: what you found and what you did. The resolution is required — the report will not close without one — and it is what makes the queue readable later.",
          "Reject it instead if the deal was right and the report was mistaken, again with a written resolution saying what you checked. That is a real outcome and it is worth recording rather than leaving open.",
        ],
        gotchas: [
          "Resolved and rejected are final for you. Once a report is closed, changing it again — back to open, or from resolved to rejected — is reopening it, which only a supervisor, an admin or an owner can do. Read the deal twice before closing.",
          "Resolving a report without touching the deal leaves the site still wrong and the queue looking clean. Fix the thing, then close the report.",
          "'I fixed it' is not a resolution. The next person reading the row needs to know what was wrong, because the same restaurant often does the same thing again.",
        ],
      },
      {
        id: "feedback",
        title: "Tester feedback and product feedback",
        kind: "reference",
        permission: "moderate_feedback",
        area: "moderation",
        summary: "The two halves of the feedback tab — problems people hit, and things they wish Radar did — and how an item is closed.",
        body: [
          "The feedback tab is split in two. Tester feedback is what went wrong for somebody: a bug, a confusing screen, a deal that was incorrect. Product feedback is feature requests: what people wish Radar did. The first is work to look into; the second is a record to read for patterns, and the pattern is usually worth more than any single entry.",
          "Move an item to reviewing while you are looking into it and resolve it when it is genuinely dealt with. Resolving needs a note saying what was found or done. Resolving things because they are old is how a queue stops meaning anything.",
          "Pilot waitlist sign-ups and homepage email leads are not feedback. They are launch signals, and they live on the Mailing list tab.",
        ],
        gotchas: [
          "Resolved is final for you, as with reports. Reopening a resolved item needs the reopen permission — a supervisor, an admin or an owner — and a reason.",
          "Anything in here saying a specific deal is wrong should be handled as an accuracy report instead. That has a deal attached and a fix that matters today.",
        ],
      },
      {
        id: "rejecting-suggestions",
        title: "Rejecting suggestions",
        kind: "reference",
        permission: "moderate_suggestions",
        area: "moderation",
        summary: "Every rejection carries a reason the sender can read. The standard reasons, and when to write your own.",
        body: [
          "A rejection with no reason reads as a shrug, and the commonest consequence is the same suggestion arriving again next week. So the workspace will not reject without one: you pick a standard reason or write your own, and the sentence is stored with the suggestion. A creator sees it in their creator workspace beside their submission. A member of the public who sent one in is not notified, so for them the reason is the record staff read later.",
          "The standard reasons are: Already listed, Not a deal, Could not find a source, Offer has ended, Details did not match, Outside where Radar lists deals, Breaks drink-advertising rules, and Restaurant closed. Each one is written to the person who sent it in — what we checked and why it could not be listed — so pick the one that is actually true rather than the nearest one.",
          "When none fits, choose Other and write the reason. It has to say something: a sentence of at least twenty characters and four words, and an answer like 'no', 'rejected' or a row of dots is refused. Write it to the sender, in a sentence they could act on.",
          "A standard reason can carry a short note of your own after it — 'Already listed — see the Tuesday wing night' — which is kept with it. The note is optional; the reason is not.",
          "Rejecting is not permanent in any way that matters. A suggestion that was rejected can be converted later if it turns out to be right, so rejecting a genuinely unusable submission is the correct call rather than a risky one.",
        ],
        gotchas: [
          "Do not reject something merely because it needs work. Pending is a legitimate place for a suggestion that is real but unfinished.",
          "A suggestion its sender withdrew cannot be rejected or converted. It is theirs to send again.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "supervisors",
    title: "Supervisors",
    blurb: "Leading the deal and moderation teams: everything both of them do, plus the decisions that undo a closed report.",
    roles: ["supervisor"],
    articles: [
      {
        id: "supervisor-role",
        title: "What a supervisor is for",
        kind: "reference",
        permission: "reopen_reports",
        area: "moderation",
        summary: "Every deal and moderation permission, the growth figures, and the one power nobody below you has: reopening a completed report.",
        body: [
          "A supervisor holds what a deal editor and a moderator hold together — creating, publishing and verifying deals, restaurant photos, suggestions, reports and feedback — and can read the growth figures. The deal editors' and moderators' articles in this handbook are yours as well; read them as the standard you are holding the team to.",
          "What makes the role different is reopening. Once a report or a feedback item is resolved or rejected, only a supervisor, an admin or an owner can change it again. That keeps a closed decision closed unless somebody senior decides it was wrong, and it makes you the person moderators come to when they think it was.",
          "You cannot change roles, see the money, run the mailing list or approve your own high-risk requests. Pausing a whole market still goes to an owner.",
        ],
        gotchas: [
          "Read the queues for patterns as well as for items: the same restaurant reported every week, a moderator whose resolutions say nothing, suggestions rejected with the nearest reason rather than the true one. The audit log keeps all of it if an owner or admin needs to look.",
        ],
      },
      {
        id: "reopening-reports",
        title: "Reopening a report or feedback item",
        kind: "howto",
        permission: "reopen_reports",
        area: "moderation",
        summary: "When a closed decision was wrong. Reopening needs a written reason and is recorded with what the item was before.",
        body: [
          "A resolved or rejected report is a decision somebody recorded, and the public listing has already moved on from it — a closed report stops the deal showing as Re-checking. Reopening puts the question back. Do it when the decision was wrong, not to tidy a resolution's wording.",
        ],
        steps: [
          "Read the report, its resolution and the deal as it stands now. Check the audit log entry if you need to know who closed it and when.",
          "Decide what the item should become: open again for somebody to work, under review because you are taking it yourself, or closed the other way — rejected instead of resolved, or the reverse.",
          "Write the reason for reopening. It is required, stored with the change, and it is what the moderator who closed it will read.",
          "Save. The audit entry records the previous status and when it had been closed.",
          "Fix the deal if that was the point — reopening the report changes nothing on the public listing except bringing back the Re-checking label while it is open.",
          "Close it again properly, with a resolution that says what was wrong the first time.",
        ],
        gotchas: [
          "Anyone without this permission who tries is refused by the server, whatever their screen shows. If a moderator asks you to reopen something, they cannot do it themselves — that is the design.",
          "Feedback works the same way: a resolved item stays resolved until a supervisor or above reopens it, with a reason.",
          "Reopening is not a way to delete a decision. The original close stays in the audit log beside your reopening.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "marketing",
    title: "Marketing",
    blurb: "Who Radar may write to, what gets promoted, and where the traffic comes from.",
    roles: ["marketing"],
    articles: [
      {
        id: "email-gates",
        title: "Why an email did not send",
        kind: "runbook",
        permission: "manage_email",
        area: "commerce",
        summary: "Radar's mail is gated four ways at the system level and once per person. Any one of them stops a send.",
        body: [
          "Mail only goes out when the pilot is enabled, the kill switch is off, the sending provider is configured and message signing is configured. All four are system settings rather than anything in this workspace, so if mail has stopped entirely that is where to look — and it needs somebody with deployment access, not somebody with this tab.",
          "On top of that, each recipient has to be admitted: either on the original allowlist, or accepted off the waitlist by staff. Somebody who signed up and is still waiting receives nothing, by design.",
          "Deal mail and other mail are separate permissions from the recipient's point of view rather than a tidiness distinction. Somebody who consented to one has not consented to the other.",
        ],
        gotchas: [
          "'Nobody is getting mail' and 'one person is not getting mail' have different causes. The first is a system gate; the second is almost always that they are still waitlisted, unsubscribed, or suppressed after a bounce.",
          "A suppressed address is one that bounced or complained. It stays suppressed and cannot be admitted — re-adding it by hand would damage Radar's ability to deliver to everybody else.",
          "Switching somebody's alerts back on refuses unless they have a confirmed consent and are not suppressed. That refusal is the system protecting a consent record rather than a bug.",
        ],
      },
      {
        id: "admit-from-waitlist",
        title: "Admit somebody to the mailing list",
        kind: "howto",
        permission: "manage_email",
        area: "commerce",
        summary: "Accepting off the waitlist is a consent decision with several moving parts. What each one does.",
        body: [
          "The waitlist is shown with the homepage email leads under Launch signals on the Mailing list tab. It is people who asked for deal alerts during the controlled pilot and have not been let in yet. Accepting somebody does not sign them up — it invites them, and they still have to confirm from their own inbox before a single email is sent.",
        ],
        steps: [
          "Check that delivery is actually on. Accepting sends an invitation, so if email is switched off the action refuses before touching the queue rather than quietly marking somebody accepted who then hears nothing.",
          "Work the queue in order unless you have a reason not to. Accepting without naming anybody takes the person who has been waiting longest.",
          "Accept. Their record moves to pending and an invitation with a confirmation link goes to their address.",
          "Leave them alone after that. Pending means the invitation is out and the next move is theirs; they are not subscribed and no roundup will reach them until they confirm.",
          "If the invitation could not be delivered, they are put straight back on the waitlist in their original place. Nothing needs undoing and they have not lost their turn.",
        ],
        gotchas: [
          "A suppressed address is refused rather than accepted. That is deliberate — inviting an address that has already bounced or complained is how a sending domain gets itself blocked.",
          "Accepting is recorded as your decision. It is a real consent step and only staff can take it: nobody can promote themselves off the waitlist.",
          "Somebody who signed up again after being waitlisted is handled by their most recent record, so accepting cannot downgrade an existing confirmation back to pending.",
        ],
      },
      {
        id: "sponsorships",
        title: "Sponsored placement",
        kind: "howto",
        permission: "manage_sponsorships",
        area: "finance",
        summary: "Putting a paid placement live, keeping the badge honest, and why deleting one waits for an owner.",
        body: [
          "A sponsorship is a dated contract against one deal in one market. While it is active the deal carries a Sponsored badge and a sort boost. The badge is not optional and not something to remove on request — it is the disclosure that makes the placement lawful.",
          "The flag on the deal follows the sponsorship rows rather than being set by hand, so a placement that has ended stops being sponsored without anyone having to remember to undo it.",
        ],
        gotchas: [
          "Sponsoring a deal does not publish it. An unpublished deal with an active sponsorship is a placement nobody can see, and the clock is still running on it.",
          "Check the market as well as the deal. A sponsorship is scoped to one city, and the wrong city buys a placement where the advertiser has no restaurant.",
          "Ending a placement early is an edit to its dates. Deleting one removes the contract along with its click and impression history, so a deletion goes to an owner for approval unless you are one — and it is rarely what you want.",
        ],
      },
      {
        id: "social-slides",
        title: "Make a carousel post from live deals",
        kind: "howto",
        permission: "manage_campaigns",
        area: "commerce",
        summary: "Social slides turns a city's live deals into 1080x1350 images for an Instagram carousel or a TikTok photo post.",
        steps: [
          "Open Social slides, type a city and choose Load deals. The list is the same set of live deals a visitor sees for that city.",
          "Tick up to eight deals in the order you want them shown. A hook slide goes first and a closing slide pointing to radar.cheap goes last.",
          "Edit any slide's wording, then add a photo: your own from the venue, or the restaurant's Radar photo once they have agreed.",
          "Choose Export all slides and save each image, then post them in order.",
        ],
        gotchas: [
          "A restaurant's photo on Radar is shown beside its own deal. Using it in an advert is a different use, so ask the restaurant first and fill in the photo credit.",
          "Do not put a city in a chain's deal wording. The city belongs on the hook slide when the post is about one city.",
          "Paid or sponsored posts need the platform's paid-partnership label. Keep it visible without making it the headline.",
        ],
      },
      {
        id: "campaign-links",
        title: "Build a tracked link and read what it brought in",
        kind: "howto",
        permission: "manage_campaigns",
        area: "commerce",
        summary: "Where the traffic on the campaigns tab comes from, and how to make a link that lands there.",
        body: [
          "A campaign link is an ordinary Radar address with tags on the end saying where it came from. Anything arriving through one is counted against those tags, which is what makes it possible to answer whether a particular post, newsletter or partner actually sent anybody.",
        ],
        steps: [
          "Open the Campaigns tab, say who owns the campaign and what it is for, and fill in the source (where the link is going to live), the campaign (what it is for) and the medium (what kind of placement it is). Keep these lower case and consistent between campaigns, because they are grouped by exact text.",
          "Set a city if the link is for one market, so people arriving land where the offers are relevant to them.",
          "Copy the generated link and use that everywhere for this campaign. A link somebody retypes without the tags is traffic you will never see.",
          "Come back and read the campaign traffic panel. It shows what arrived per source, so two campaigns with different tags can be compared honestly.",
        ],
        gotchas: [
          "Tags with different spellings are different campaigns. 'instagram' and 'Instagram' will not add up.",
          "A campaign that brought visits but no subscriptions is a real answer rather than missing data. See the analysts' section for how a rate with no denominator is shown.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "finance",
    title: "Finance",
    blurb: "The money: what affiliates earn and are paid, comped plans, and the revenue and subscription figures. Real money moves from here, so most of it is written as steps.",
    roles: ["finance_manager"],
    articles: [
      {
        id: "finance-role",
        title: "What the finance manager owns",
        kind: "reference",
        permission: "manage_finance",
        area: "finance",
        summary: "Affiliates end to end, comps, revenue and subscription figures, and sponsorship contracts — and the payout step that still needs an owner.",
        body: [
          "The finance permission covers the whole affiliate program: approving applicants (which sets the rate they are paid at), deciding commissions, and requesting payouts. It also covers comping Pro, and reading revenue, subscription movement and active comps in the Admin area. Finance managers hold the sponsorship permission too, because a placement is a contract with money behind it.",
          "Paying out is the one step that still waits. A payout sends real money out of Radar's Stripe balance, so a request from anyone but an owner goes to an owner for approval before any transfer is made.",
          "Nothing here changes anybody's role or reaches the catalog. If an affiliate needs a different account type, or a restaurant needs access, that is an owner or admin's job.",
        ],
        gotchas: [
          "Money is shown per currency and never added across currencies. A total you expected as one number may deliberately not exist.",
        ],
      },
      {
        id: "affiliate-program",
        title: "How the affiliate program pays",
        kind: "reference",
        permission: "manage_finance",
        area: "finance",
        summary: "Rates, the holding period, where attribution comes from, and the one rule about the word 'paid'.",
        body: [
          "An affiliate earns a share of every Radar Pro payment made by somebody who signed up through their link — on every renewal, not once. Monthly subscriptions pay 20% and yearly ones 10%: a dollar out of every five, and five out of every fifty.",
          "A commission is recorded the moment Stripe reports the payment and then sits in a thirty-day holding period, which is the window for refunds and chargebacks. An hourly job matures it to ready. Once an affiliate's ready balance passes the minimum for its currency, either they or you can send it.",
          "Attribution is written when the referred account is created and is never rewritten afterwards. Somebody who signed up through one link stays with that affiliate; somebody who already had an account is attributed to nobody, whatever link they used later.",
          "Subscriptions bought inside the iphone app earn nothing, because Apple takes those payments and there is no Radar payment to share. Affiliates are told this on their dashboard, beside their link and on the public page — when one asks why a referral did not count, this is usually the answer.",
        ],
        gotchas: [
          "There is no 'mark as paid'. A commission says paid only when a Stripe transfer covering it has actually gone out. If you find yourself wanting to set it by hand, something else is wrong — ask.",
          "You cannot change a commission a payout is already carrying. The workspace refuses it and says so; reversing the payout is what puts those commissions back.",
          "Balances are kept per currency and never added together. There is no single grand total, on purpose — adding Canadian to US dollars would invent an exchange rate.",
          "An affiliate's rate is stamped on each commission as it is earned, so changing their rate changes what they earn from then on and never rewrites what they have already earned.",
        ],
      },
      {
        id: "creator-accounts",
        title: "Approve an affiliate application",
        kind: "howto",
        permission: "manage_finance",
        area: "finance",
        summary: "Turning an applicant into a creator with a handle, and the one refusal that means 'change the role first'.",
        body: [
          "Approving is a single step that sets the role, creates the profile and assigns the handle together, because any two of those without the third leaves a half-made account for somebody to finish by hand.",
          "The handle is the public half of their tracked link and the key every attributed visit and sign-up is stamped with. Staff set it — an applicant can request one but cannot choose or change it — and it has to be unique.",
        ],
        steps: [
          "Read the application. The handle they asked for is filled in for you and you can change it before approving; approving is agreeing to a name rather than inheriting one.",
          "Check the handle is sensible and free. It has to be 2 to 32 characters of lower-case letters, numbers and hyphens, starting with a letter or number, and the save refuses if another creator already has it.",
          "Set the commission rate if it differs from the standard one. Leaving it alone keeps the default.",
          "Approve. The account becomes a creator, the profile and handle are created, and they are emailed the decision.",
          "Reject instead, with a reason, if it is not right. The reason is emailed to them.",
        ],
        gotchas: [
          "If the account already holds another role, approval refuses and says so. That is deliberate: promoting them automatically would silently take away a restaurant manager's portal or an admin's workspace. Change the role on purpose first, then approve.",
          "The decision email is sent after the approval, so a mail failure leaves them approved with a warning shown to you rather than rolling back their account. Tell them yourself if that happens.",
          "Editing an existing creator's profile is done from Users, by whoever manages accounts. Saving it without touching the rate leaves the rate exactly as it was — a dialog saving a name change is not consent to reset somebody's commission.",
          "Clearing a creator's handle removes their profile and their workspace, while every commission and visit already stamped with that handle stays exactly as it is.",
        ],
      },
      {
        id: "commission-decisions",
        title: "Decide a commission: release, refuse, void, or put it back",
        kind: "howto",
        permission: "manage_finance",
        area: "finance",
        summary: "The four things staff can do to a commission, and the two the workspace will refuse.",
        body: [
          "Commissions are marked, never deleted. An affiliate who has been shown a figure has to be able to find it again, and a decided row explains itself where a missing one cannot.",
        ],
        steps: [
          "Release the hold when you are satisfied a payment is not coming back — that makes the commission payable now instead of at the end of the thirty days.",
          "Refuse it when it is not owed at all. A reason is required, because the affiliate can read it, and 'no' without one generates a question you will have to answer anyway.",
          "Void it when the payment behind it came back — a refund or a chargeback. That is a statement about the payment rather than about the affiliate.",
          "Put it back to pending if you released it too early. That returns it to the hold rather than undoing anything permanent.",
        ],
        gotchas: [
          "A commission inside a payout is refused with a message saying so. Reverse the payout first; that returns every commission it was carrying.",
          "A commission that has already been paid cannot be changed at all. Money has left, and editing the record would only make the ledger disagree with Stripe.",
        ],
      },
      {
        id: "pay-an-affiliate",
        title: "Pay an affiliate",
        kind: "howto",
        permission: "manage_finance",
        area: "finance",
        summary: "Sending real money from the Affiliates tab, and what you are and are not choosing.",
        body: [
          "You choose an affiliate and a currency. Nothing else about the amount comes from you — the ledger works out what is ready and pays exactly that, so there is no field here that could pay somebody more than they are owed.",
        ],
        steps: [
          "Open the Affiliates tab and find them in the balances panel. The ready column is what a payout would move today.",
          "If the row shows a reason instead of a button — no Stripe account, setup unfinished, nothing ready, below the minimum — that is the thing to deal with, and most of it is theirs to do rather than yours.",
          "Read the amount, then confirm. If you are an owner, Radar creates a Stripe transfer to their connected account at once and the commissions in it are settled as it goes out.",
          "If you are not an owner, confirming sends the payout to an owner for approval and no money moves yet. The owner sees the affiliate, the currency and what was owed when you asked; approving pays what is ready at that moment, which can be more than when you asked if more has matured since.",
          "Check the payouts panel. The row carries the Stripe transfer id, which is what you quote if anybody has to trace the money later.",
        ],
        gotchas: [
          "This moves real money and cannot be undone from here. Read the amount before confirming — and that is why it needs an owner's approval when anyone else asks.",
          "Do not tell an affiliate they have been paid until the payouts panel shows the transfer. 'Sent to an owner' means waiting.",
          "Affiliates can pay themselves from their own portal, so you do not need to do it for them. This is for somebody who asks, or a balance somebody wants settled before a period closes.",
          "An inactive affiliate account is refused rather than paid. Sort out why the account is paused before trying again.",
          "A failed payout returns every commission in it to the affiliate's available balance automatically. Nothing is lost and nothing needs re-entering by hand.",
        ],
      },
      {
        id: "payout-failed",
        title: "A payout says failed",
        kind: "runbook",
        permission: "manage_finance",
        area: "finance",
        summary: "What the failure reason is telling you, and what to do about each kind.",
        steps: [
          "Read the reason on the payout row. It is Stripe's own words rather than a Radar paraphrase.",
          "If it is an insufficient balance, the payout was legitimate and Radar's own Stripe balance was short at that moment. Nothing is broken; retry once the balance covers it.",
          "If it names the affiliate's account — verification outstanding, account restricted — their Stripe setup is the blocker and only they can finish it. Their own portal shows them the same message.",
          "For anything else, do not retry repeatedly. Quote the payout id and the transfer id and ask.",
        ],
        gotchas: [
          "The commissions came back on their own when the payout failed. Do not try to reconstruct them by hand.",
          "A payout stuck at starting rather than failed means Radar recorded it and never heard back. Leave it and ask: retrying is how one payout becomes two transfers, and the second one is real money too.",
        ],
      },
      {
        id: "comp-a-subscription",
        title: "Give somebody Pro without a subscription",
        kind: "howto",
        permission: "manage_finance",
        area: "admin",
        summary: "A comped month, access during a refund, a review account. What a grant is and what it deliberately does not touch.",
        body: [
          "A grant is a record, not a flipped switch. It says who granted Pro to whom, why, and when it runs out — which is the question that always gets asked eventually, and the one that editing the database by hand can never answer.",
          "It never touches the subscription status. That field is Stripe's vocabulary and the billing screens read it as such, so writing anything into it would make a comped account look like a subscription that does not exist.",
        ],
        steps: [
          "Open the comps panel in the Admin area and find the account by email address — the address is usually what you have, because you are reading a support message.",
          "Write the reason. It is required, and 'comped after the March outage' is worth far more later than 'support'.",
          "Set an expiry if the comp is meant to end, as a plain year-month-day date. Leave it empty for an open-ended grant, and expect to be the person who remembers it.",
          "Save. They have Pro immediately.",
          "To take it back, revoke the grant. Radar then works out what they are entitled to from any real subscription they have, so revoking a comp from somebody who also pays does not drop them to free.",
        ],
        gotchas: [
          "A grant is the honest way to do this. Any other route leaves an account holding Pro with no explanation attached to it.",
          "Never take card details from anybody to sort out a payment, through any channel. There is no situation in this job that needs them.",
        ],
      },
      {
        id: "revenue-figures",
        title: "Where the revenue and subscription figures come from",
        kind: "reference",
        permission: "manage_finance",
        area: "admin",
        summary: "What the revenue, subscription and comp panels in the Admin area count, and what they leave out.",
        body: [
          "Revenue is money actually collected: the paid invoices Stripe reports, all time and over the last thirty days. It is never a headcount multiplied by a price, because the account list cannot tell a monthly subscriber from a yearly one. Subscription movement counts the subscriptions started and canceled.",
          "Purchases inside the iphone app go through Apple rather than Stripe and are not in these figures, so they are a floor on Radar Pro rather than the whole of it.",
          "Comped accounts are listed separately, with who granted each one, why, and when it ends. A comp is Pro without a payment, so it is never counted as revenue.",
          "Every figure is per currency. Canadian and US dollars are never added together, because adding them would invent an exchange rate.",
        ],
        gotchas: [
          "Radar follows Stripe rather than the other way round. If a figure here disagrees with Stripe's dashboard, Stripe is right and the difference is usually an event that has not arrived yet — see 'A subscriber says they paid and Radar disagrees'.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "analysts",
    title: "Analysts",
    blurb: "Reading the workspace without changing it: where each figure comes from, and what it deliberately does not say.",
    roles: ["analyst"],
    articles: [
      {
        id: "read-only",
        title: "What read-only access means here",
        kind: "reference",
        permission: "read_admin",
        summary: "You can see almost everything and change nothing. That is the design rather than an oversight.",
        body: [
          "Read access opens the workspace: the catalog, the restaurants, the staff directory and this handbook. Everything else is read by permission too, not only written — an analyst also holds the analytics permission, so sees the growth figures and campaign traffic, but not the moderation queues, the mailing list, the accounts or the money. Those arrive empty rather than as an error.",
          "Every action needs its own permission on top, so an analyst account can change nothing at all.",
          "That is what makes the account safe to hand out. It also means that when you spot something wrong, the fix is a message to whoever owns that queue rather than something you can quietly do — which is worth saying in the message, because it tells them it is now theirs.",
        ],
        gotchas: [
          "Never sign in as somebody else to make a change you cannot make. The audit trail will name them for it, which turns a small favor into a record that is wrong.",
        ],
      },
      {
        id: "reading-the-numbers",
        title: "Where each figure on the growth tab comes from",
        kind: "reference",
        permission: "view_analytics",
        area: "commerce",
        summary: "Engagement, deal performance, visits, searches, leads and cities — anonymous product figures, and their traps.",
        body: [
          "The growth tab answers product questions: what people do once they arrive, which deals get viewed and saved, what they search for and fail to find, where leads come from, and which cities and restaurants carry the catalog. These are anonymous counts; nothing on the tab names a person.",
          "Revenue, subscriptions and comps are not here. They are money, and they sit in the Admin area for the people who hold the finance permission.",
          "A rate with nothing in its denominator shows as a dash rather than as 0%. Nobody converted and nobody arrived are different facts, and a zero would quietly merge them.",
          "Counts at the top of a tab are computed across everything. A list below one is often a capped, recent page of the same thing and says so — a list headed '8 most recent of 240' is telling you exactly what it is.",
        ],
        gotchas: [
          "Deal performance reflects what the public site has been serving, which is not always what this workspace shows. A deal corrected an hour ago was wrong for everybody who saw it before that — see 'I changed a deal and the site still shows the old one'.",
          "Campaign figures only count traffic that arrived through a tagged link. Somebody who typed the address in is real traffic and untagged, so campaign totals are a floor rather than the whole picture.",
          "Affiliate attribution is set when an account is created and never rewritten, so a referral figure is not a claim about who influenced somebody — only about which link they arrived by.",
        ],
      },
      {
        id: "numbers-disagree",
        title: "Two screens show different numbers",
        kind: "faq",
        permission: "read_admin",
        summary: "Usually because they are answering different questions rather than because one of them is wrong.",
        body: [
          "The commonest cause is a total against a capped list: the count is across everything, the list is a recent page of it. The list generally says so in its own heading.",
          "The second commonest is currency. Nothing sums across currencies, so a per-currency breakdown will never add up to a grand total, because there is no grand total.",
          "The third is time. Some figures are all-time and some cover a window, and two windows that both look like 'recent' may not be the same length.",
        ],
        gotchas: [
          "Before reporting a discrepancy, check whether one of the two is a capped list. It saves everybody an afternoon.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "developers",
    title: "Developers",
    blurb: "The technical side of the workspace: whether the services Radar depends on are configured, and the data exports only this role can make.",
    roles: ["developer"],
    articles: [
      {
        id: "developer-tools",
        title: "What the Developer area shows",
        kind: "reference",
        permission: "developer_tools",
        area: "admin",
        summary: "Which integrations are configured, why email can or cannot go out, and test purchases. Read-only, and nothing editorial.",
        body: [
          "The Developer area answers 'is it set up?' for the services Radar depends on: maps, the email provider, the email pilot. Each is shown as configured or not — never the key or the value itself, which stays in the deployment's secrets and nowhere in this workspace.",
          "Email delivery readiness is broken into its four gates: the pilot is enabled, the kill switch is off, the sending provider is configured and message signing is configured. Whoever runs the mailing list sees only a yes or no; this is where you find which gate is closed.",
          "Test purchases are listed so a payment made while testing can be told apart from a real one before anybody counts it.",
          "This permission, and the export permission, can only be held by the developer role and by owners. No preset edit and no custom permission set can hand them to anybody else — it takes changing the person's role, which only an owner can do.",
        ],
        gotchas: [
          "You have no editorial or account powers. If a check here shows something the catalog, the mailing list or an account needs, tell whoever owns it.",
          "Fixing a closed gate means changing the deployment's configuration, which is outside this workspace. Note what is missing and the time you saw it.",
        ],
      },
      {
        id: "exports",
        title: "Make a data export",
        kind: "howto",
        permission: "export_data",
        area: "admin",
        summary: "CSV files are made on the server, one dataset at a time, capped and audited. What you can export on your own and what needs an owner.",
        body: [
          "Exports are only ever made on the server. There is no download button anywhere else in the workspace, and nothing builds a file in the browser from what a page happens to hold. Every export writes an audit entry naming you, the dataset, the filters and how many rows went out.",
          "An export is a way of reading, never a way around the rule for reading. Deals and restaurants are open to anybody in the workspace, so you can export them. Users need the account permission, subscribers need the mailing-list permission and the audit log needs an owner or admin, so those are in practice made by an owner.",
        ],
        steps: [
          "Get the request in writing: which dataset, which filters, and what it is for. Somebody asking for 'everything' usually needs one city or one status.",
          "Open the Developer area and choose the dataset: deals, restaurants, users, subscribers or the audit log.",
          "Set the filters the dataset offers — deals can be narrowed by status, country, province or state and city; the audit log by action. Narrower is faster and safer.",
          "Download the file and check the row count against what was asked for.",
          "Send it only to the person who asked, through a channel the team already uses, and delete your own copy when they have it.",
        ],
        gotchas: [
          "Each file holds at most 2,000 rows. A file that stops at exactly that many was cut off; narrow the filter and export in parts.",
          "A people export you are refused is the system working: you can read the catalog, not the accounts. Pass the request to an owner.",
          "The audit entry is permanent. That is the point — a dataset leaving the workspace should always be traceable to who took it and why.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "admins",
    title: "Admins and owners",
    blurb: "Access, approvals, and the decisions that cannot be taken back. Most of this is refused for everybody else, and some of it is refused for admins too.",
    roles: ["owner", "admin"],
    articles: [
      {
        id: "roles",
        title: "What each role can do",
        kind: "reference",
        permission: "manage_users",
        area: "admin",
        summary: "The presets, the custom set, the two permissions only developers hold, and the two roles that are not staff at all.",
        body: [
          "Owner has everything and cannot be locked out, and is the only role that can carry out the high-risk actions. Admin has full operational control except exports and developer tools, and its high-risk requests wait for an owner like anyone else's. Supervisor leads the deal and moderation teams and is the first role that can reopen a closed report. Finance manager owns affiliates, payouts, comps, revenue and sponsorship contracts. Developer sees integrations and delivery readiness and makes exports, with no editorial or account powers. Deal editor creates, publishes and verifies deals and manages restaurant photos. Moderator works the public queues. Marketing has the mailing list, campaigns and sponsorship placements. Analyst reads the catalog and the growth figures and changes nothing.",
          "The presets and what each grants are in Admin → Roles & permissions. Owners and admins can read the grid; only an owner can change it.",
          "Exports and developer tools are locked to the developer role and to owners. The grid will not grant them to any other preset or custom set, so giving somebody an export means changing their role, which is an owner's decision.",
          "If somebody needs one permission outside their preset, give them a custom set rather than promoting them into a wider role. Custom is per person, so it does not quietly widen everybody else who shares a role, and it is as easy to take back as it was to give.",
          "Creator and restaurant are not staff roles. They resolve to no staff permissions at all, in code rather than from a table, and they open their own workspaces instead of this one.",
          "One owner account is pinned in code and cannot be changed by anybody, including other owners. That is deliberate: it guarantees the workspace always has a way back in.",
        ],
        gotchas: [
          "Moving somebody to creator or restaurant removes their staff access entirely. It is not a sideways step.",
          "Editing a role preset changes it for everybody holding that role, not just the person whose row you were looking at.",
          "A write permission without read_admin grants nothing usable — the person cannot open the workspace to use it. A custom set always needs read_admin.",
        ],
      },
      {
        id: "change-someones-role",
        title: "Change somebody's role or permissions",
        kind: "howto",
        permission: "manage_users",
        area: "access",
        summary: "The steps, and every refusal you can meet on the way — each of which is protecting something specific.",
        steps: [
          "Find the person in Users and decide what they actually need to do, rather than which title sounds right. Admin → Roles & permissions lists what each preset grants.",
          "Choose the role — or choose custom and tick exactly the permissions they need.",
          "Write the reason. It is required, it is stored with the change, and it is the only thing that will explain this decision to somebody reading the log next year.",
          "Save. The change takes effect immediately; they do not need to sign out and back in.",
          "Tell them what changed. A permission arriving silently looks like the workspace behaving differently for no reason.",
        ],
        gotchas: [
          "Only an owner can make most role changes. An admin can onboard a creator or a restaurant account, and can move one of those back to an ordinary user, because neither is a step toward staff access — anything else needs an owner.",
          "A reason is not optional. The save refuses without one.",
          "You cannot remove your own owner access, and Radar will not let the last owner be demoted. Between them, those two stop the workspace being locked out by a single mistaken click.",
          "One owner account is permanently protected and is refused to everybody, including other owners.",
          "Changing somebody to any ordinary role clears a custom permission set they had. If they were custom for a reason, moving them to a preset and back is not a round trip.",
        ],
      },
      {
        id: "decide-owner-approvals",
        title: "Decide an approval request",
        kind: "howto",
        permission: "read_admin",
        roles: ["owner"],
        area: "admin",
        summary: "Owners only. Reading a held request, approving it so it runs exactly as asked, or declining it with a note the requester reads.",
        body: [
          "Pausing or archiving a market, deleting a sponsorship, paying an affiliate and flipping an operator switch only happen when an owner says so. Anybody else holding the permission can ask, and their request waits in Admin → Approvals with a one-line summary the server wrote from the records — not from what the requester's screen said.",
        ],
        steps: [
          "Open Admin → Approvals. Each request shows what it would do, who asked, their role, when, and their reason.",
          "Check it against the records it names: the market's deals, the sponsorship, the affiliate's ready balance, the switch's current state. A payout pays what is ready when you approve, which can differ from the figure at the time of asking.",
          "Approve it to run it now, exactly as it was asked, under your name. You confirm again first. The audit entry points back to the request.",
          "Or decline it with a note saying why. The note is required, because the person who asked reads it.",
          "Read the result. If the action itself refused when it ran — the market had already been paused, the balance had already been paid — the request is marked failed with the reason, and nothing changed.",
        ],
        gotchas: [
          "Your own requests run immediately; they never wait in this list.",
          "Two owners deciding the same request at once is safe: it is claimed before it runs, so it runs once and the second owner is told it was already decided.",
          "A request that sits for days is a decision too. If you will not approve it, decline it with a reason rather than leaving it for the requester to guess.",
        ],
      },
      {
        id: "read-the-audit-log",
        title: "Read the audit log",
        kind: "howto",
        permission: "read_admin",
        roles: ["owner", "admin"],
        area: "access",
        summary: "Owners and admins. Finding who did what to a record, and what the log can and cannot be used for.",
        steps: [
          "Open the Audit log and use its search and filters to narrow it to the record, the person or the action you are asking about.",
          "Read the entry's details: the role the person held at the time, the record, the reason they gave and the specifics — which deal, which amount, which role somebody moved from and to.",
          "For an action an owner approved, follow the approval id back to the request to see who asked and why.",
          "For an export, the entry names the dataset, the filters and how many rows went out.",
        ],
        gotchas: [
          "The log cannot be edited or deleted by anyone, through the workspace or directly in the database. A wrong action is corrected by a new one, which leaves its own entry.",
          "Hidden accounts appear in the log like any other. Hiding keeps somebody out of a list; it never removes their history.",
        ],
      },
      {
        id: "hidden-accounts",
        title: "Hiding an account",
        kind: "reference",
        permission: "manage_users",
        area: "access",
        summary: "What hiding does, who can see hidden accounts, and why you cannot hide your own.",
        body: [
          "Hiding keeps an account out of the user list that other roles see. It does not suspend anybody, it does not remove access and it is not a punishment — it is for accounts that would otherwise clutter or expose something in a list many people read.",
          "Only owners and admins can hide an account, and only owners and admins can see the hidden ones. That pairing is the whole point: hiding would mean nothing if holding the user-management permission were enough to both set it and see through it.",
        ],
        gotchas: [
          "You cannot hide yourself. The row you would then need to click is the row that just disappeared.",
          "Hiding is not how you stop somebody's access. Changing their role does that, and it is visible.",
        ],
      },
      {
        id: "restaurant-managers",
        title: "Give a restaurant access to its own listings",
        kind: "howto",
        permission: "manage_users",
        area: "access",
        summary: "Inviting a manager, what to do when the invitation cannot be emailed, and how to take access away.",
        body: [
          "A restaurant's authority comes from a manager record for that specific restaurant, not from the account's role. Every portal request re-checks that record rather than trusting the role, which is why most managers still show as ordinary users.",
        ],
        steps: [
          "Open the restaurant in the Restaurants tab and invite a manager by email address.",
          "Send it. A pending manager record is created immediately and an invitation goes to that address.",
          "If delivery is restricted or fails, the dialog hands you the invitation link instead. The invitation is real either way — copy the link and give it to them through a channel you trust.",
          "They accept from the link, which is what turns the pending record into access.",
          "To take access away, revoke the manager record. Changing their account role does not do it.",
        ],
        gotchas: [
          "The invitation link is an access grant. Treat it like one: do not paste it into a public channel, and do not send it to an address you have not confirmed belongs to the restaurant.",
          "Inviting the same person for a second restaurant is a second invitation. A manager record covers one restaurant.",
        ],
      },
      {
        id: "someone-lost-access",
        title: "Somebody cannot get in",
        kind: "runbook",
        permission: "manage_users",
        area: "access",
        summary: "Working out which of several different problems it actually is.",
        steps: [
          "Find their account in Users. If it is not there they have never signed in — an account is created on first sign-in, and an invitation is not an account.",
          "Check their role and permissions. 'I can sign in but the workspace is empty' is a permission question rather than a login one.",
          "Check whether the account is hidden. A hidden account is perfectly real and simply kept out of other roles' lists.",
          "Check which workspace they should be in. A creator lands in the creator workspace and a restaurant in the portal, and both will tell somebody expecting this one that they cannot get in.",
          "If they cannot sign in at all, that is the identity provider rather than Radar, and it is not fixable from here. Do not attempt to reset anybody's credentials for them.",
        ],
        gotchas: [
          "Never sign in as somebody else to 'check'. The audit trail will name them for everything you then do, which is worse than the problem you were helping with.",
        ],
      },
      {
        id: "operator-switches",
        title: "Switches that take effect without a deploy",
        kind: "reference",
        permission: "manage_users",
        area: "admin",
        summary: "A short allow-list of operational settings in the Admin area, why the list is short, and why flipping one needs an owner.",
        body: [
          "A few settings can be changed here and take effect immediately rather than needing a code change and a deploy. Free trials for new subscribers is the current one: off by default, so it can be switched on for a launch or a creator's video and switched off the same day rather than being left on and forgotten.",
          "Only keys on a fixed allow-list mean anything. A typo is refused rather than written, because a stored setting nothing reads looks exactly like a switch that does not work.",
          "Every switch's state is visible to anybody who can open the workspace. Flipping one needs the account-management permission and an owner: an owner's flip applies at once, anyone else's goes to an owner for approval.",
        ],
        gotchas: [
          "Turning trials off does not touch anybody already trialing. Their trial finishes the way it was sold to them, because the running subscription belongs to Stripe.",
          "Every flip is recorded with who did it. If a switch is on and nobody remembers why, the log knows.",
        ],
      },
      {
        id: "creator-picks",
        title: "A creator's pick has to come down",
        kind: "reference",
        permission: "manage_users",
        area: "catalog",
        summary: "Staff can remove a pick and nobody can write one. Why the tool is deliberately one-directional.",
        body: [
          "A pick puts a named creator's recommendation next to a deal. Staff can take one down — that is moderation — but nothing here can create or edit one, because a tool that could put words beside somebody's name would make every byline on the site deniable.",
          "Editing belongs to the creator, in their own workspace. If a pick needs changing rather than removing, that is a conversation with them.",
        ],
      },
      {
        id: "delete-an-account",
        title: "Somebody asks to be deleted",
        kind: "runbook",
        permission: "manage_users",
        area: "access",
        summary: "The one genuinely irreversible request, and what survives it on purpose.",
        body: [
          "Account deletion removes the person's data and cannot be undone, so confirm the request is genuinely from them before acting on it. A message asking for somebody else's account to be deleted is not a deletion request.",
          "Some records survive deliberately, and it is worth being able to say why. A commission row records that an affiliate earned a share of a real invoice — it keeps the money correct and is detached from the person rather than removed with them.",
        ],
        gotchas: [
          "Deleting is not how you stop somebody's access. Changing a role or revoking a manager record does that, and both are reversible.",
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "breaks",
    title: "When something looks wrong",
    blurb: "The behaviors that look like faults and are not, and the ones that are. Whoever happens to be looking at it.",
    roles: [],
    articles: [
      {
        id: "change-not-showing",
        title: "I changed a deal and the site still shows the old one",
        kind: "runbook",
        permission: null,
        area: "catalog",
        summary: "The single most common false alarm. Two different surfaces update at two different speeds.",
        body: [
          "Search results, the home page and the app read from a shared snapshot that notices your edit within about a minute. If the deal list is still wrong well after that, something is genuinely off.",
          "A deal's own page is different. Those pages are built into static files when the site is deployed, which is what makes them fast, and each one holds whatever the database said at that moment. Nothing running on the site can refresh them — so an edit made here does not reach a deal's own page until the next deployment.",
          "Deployments happen regularly, and on demand when somebody with repository access triggers one. So a correction is live in search within a minute and on the deal's page at the next deploy.",
        ],
        gotchas: [
          "This is the reason to pause a wrong deal rather than only editing it. Pausing takes it out of the list immediately; editing leaves the old page up until a deploy.",
          "If somebody is waiting on a correction — a restaurant, a reporter — say which of the two they are looking at. 'It is fixed in search and the page updates at the next deploy' is a real answer; 'it is fixed' is not.",
          "Deleting rows has the same delay as editing them. A deletion that appears to have done nothing is usually this rather than a failed delete.",
        ],
      },
      {
        id: "site-is-slow",
        title: "The site is slow, erroring, or showing a 'high traffic' message",
        kind: "runbook",
        permission: null,
        summary: "What you can tell from here, and where it stops being yours to fix.",
        steps: [
          "Check whether this workspace itself is responding. If it is fine and the public site is not, that narrows things a long way.",
          "A 'we're seeing unusually high traffic' message is the site deliberately shedding load rather than falling over, and it clears on its own.",
          "Repeated errors loading deal data usually mean the database is refusing reads. That is not fixable from here.",
          "Do not retry a failing write in a loop hoping it takes. Write down what you were doing, the exact time and the message, and raise it.",
        ],
        gotchas: [
          "The timestamp matters more than the screenshot to whoever comes to look — it is what makes a log searchable.",
        ],
      },
      {
        id: "stripe-questions",
        title: "A subscriber says they paid and Radar disagrees",
        kind: "runbook",
        permission: null,
        summary: "Where the truth lives when a customer and the site disagree about money.",
        body: [
          "Stripe is the record, not Radar. Radar's copy of somebody's plan follows the events Stripe sends, so a disagreement is usually an event that has not arrived or has not been processed yet rather than a lost payment.",
          "Purchases made in the iphone app do not go through Stripe at all — those are Apple's and they appear differently. Establish which of the two somebody used before looking anywhere else.",
          "If access needs restoring while this is sorted out, that is a grant of Pro, which belongs to whoever holds the finance permission. Ask rather than improvising something in the meantime.",
        ],
        gotchas: [
          "Never take card details from somebody to 'check' a payment, over any channel. There is no situation in this job that requires them.",
          "A past-due subscription is not a canceled one. There is a short grace period before access ends, and somebody inside it still has Pro.",
        ],
      },
    ],
  },
];

/** Every article, flattened, with the section it came from. */
export function allArticles() {
  return HANDBOOK.flatMap((section) => section.articles.map((article) => ({ section, article })));
}

/**
 * The text an article is searched over.
 *
 * Everything the reader can see, joined, so a search matches on a phrase from a step or a gotcha
 * and not only on a title — somebody looking for "waitlisted" or "confirmation phrase" is quoting
 * the sentence that confused them, not the heading it sits under.
 */
export function searchTextFor(article: HandbookArticle) {
  return [article.title, article.summary, ...(article.body || []), ...(article.steps || []), ...(article.gotchas || [])]
    .join(" ")
    .toLowerCase();
}

/**
 * The sections, with the reader's own role's section first.
 *
 * Order only — this function filters nothing; readableHandbook below does that. A custom role
 * matches no preset section, so it falls back to what the person can actually do; every other role
 * matches its own section by name, and the role-less sections keep their place in the handbook's
 * own order, which runs from "how this place works" to "when something looks wrong" for a reason.
 */
export function handbookFor(role: string, permissions: ReadonlySet<string>) {
  const isMine = (section: HandbookSection) =>
    (section.roles as readonly string[]).includes(role) ||
    (role === "custom" &&
      section.roles.length > 0 &&
      section.articles.some((article) => article.permission !== null && permissions.has(article.permission)));
  return HANDBOOK.map((section) => ({ section, mine: isMine(section) })).sort(
    (a, b) => Number(b.mine) - Number(a.mine),
  );
}

/** Who is reading: the same two facts every other rule in the workspace is decided on. */
export interface HandbookViewer {
  role: string;
  permissions: ReadonlySet<string>;
}

/**
 * Whether one article may be served to this reader.
 *
 * Its permission, held; and where it names roles, one of them — owner always counts, since owner
 * holds everything. An article with neither is everybody's.
 */
export function canReadArticle(article: HandbookArticle, viewer: HandbookViewer) {
  if (article.permission !== null && !viewer.permissions.has(article.permission)) return false;
  if (article.roles && viewer.role !== "owner" && !(article.roles as readonly string[]).includes(viewer.role)) return false;
  return true;
}

/** One article as the page receives it: the content plus the label for its kind. */
export interface HandbookArticleView {
  id: string;
  title: string;
  kind: HandbookKind;
  kindLabel: string;
  area: AdminArea | null;
  summary: string;
  body: string[];
  steps: string[];
  gotchas: string[];
}

export interface HandbookSectionView {
  id: string;
  title: string;
  blurb: string;
  /** Written for the reader's own role, so it comes first. */
  mine: boolean;
  /** One of the sections every member of staff reads. */
  everyone: boolean;
  articles: HandbookArticleView[];
}

/** What GET /api/admin/handbook answers with. */
export interface HandbookPayload {
  sections: HandbookSectionView[];
  /** How many articles exist that this reader is not served, so the page can say so. */
  withheld: number;
}

/**
 * The handbook as one reader may see it: their own section first, each section holding only the
 * articles they may read, and a section left with none dropped rather than shown as an empty
 * heading. This is the whole visibility rule, and it runs on the server.
 */
export function readableHandbook(viewer: HandbookViewer): HandbookPayload {
  let withheld = 0;
  const sections: HandbookSectionView[] = [];
  for (const { section, mine } of handbookFor(viewer.role, viewer.permissions)) {
    const articles: HandbookArticleView[] = [];
    for (const article of section.articles) {
      if (!canReadArticle(article, viewer)) {
        withheld += 1;
        continue;
      }
      articles.push({
        id: article.id,
        title: article.title,
        kind: article.kind,
        kindLabel: HANDBOOK_KIND_LABELS[article.kind],
        area: article.area ?? null,
        summary: article.summary,
        body: article.body ?? [],
        steps: article.steps ?? [],
        gotchas: article.gotchas ?? [],
      });
    }
    if (articles.length) {
      sections.push({ id: section.id, title: section.title, blurb: section.blurb, mine, everyone: section.roles.length === 0, articles });
    }
  }
  return { sections, withheld };
}
