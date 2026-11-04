// The rules on advertising drink prices, by province and state, and the check that applies them.
//
// Why this exists
// ---------------
// A large share of Radar's catalog is happy hour, and drink prices are regulated wherever Radar
// lists them. The rules bind the bar, not Radar, but a listing that describes something the bar is
// not allowed to do is evidence against it, and a few rules reach anyone who advertises: Quebec's
// rules on content apply to "nul" (anyone), and British Columbia's guidance says people without a
// liquor licence may not advertise liquor prices at all. A stale price is a trust problem; an
// illegal one is worse. So drink deals are checked against the rules of the place they run before
// they go live, and the internal research process applies the same rules before it drafts
// anything.
//
// The research behind every entry below, with its sources, is kept with the drink-advertising
// rules. Change the two together, and re-check an entry before relying on it past its `checked`
// date: three of these regimes changed in 2024-2026 (Indiana, Alberta, Michigan).
//
// Two severities
// --------------
// "block" stops a deal from going live: the single publish (lifecycle), the draft batch, and a
// restaurant manager's edit to a live deal all refuse it. Only for what is clear from the copy:
// a practice that is banned nearly everywhere (free, unlimited or 2-for-1 drinks, drinking games,
// ladies' nights), a happy hour in a state that bans them, a drink price below the provincial
// minimum, a discount on drinks in Quebec. Each says what to change.
//
// "check" is shown to staff and never stops anything: what depends on facts the copy cannot
// settle, such as whether a price holds for the whole business day, or a happy hour running past a
// state's cutoff (the venue's hours could be misread as easily as broken).
//
// It reads the copy a reader sees, like app/alcohol.ts, because that is what is published.

import { namesDrink, referencesAlcohol, READABLE_FIELDS } from "./alcohol";
import { regionName } from "./region-names";
import { sourceKind } from "./review-queue";
import { parseScheduleText, type ScheduleWindow } from "./schedule-text";

export type DrinkRuleSeverity = "block" | "check";

export type DrinkRuleCode =
  | "free_drinks"
  | "unlimited_drinks"
  | "multi_drink_pricing"
  | "drinking_games"
  | "group_pricing"
  | "happy_hour_banned"
  | "full_day_pricing"
  | "below_minimum"
  | "discount_wording"
  | "late_discount"
  | "long_discount"
  | "licensee_source"
  | "national_banned_states";

export interface DrinkRuleIssue {
  code: DrinkRuleCode;
  severity: DrinkRuleSeverity;
  /** "CA-ON", "US-MA", or "all" for a rule applied everywhere. */
  jurisdiction: string;
  /** What is wrong and what to change, in the words the admin shows. */
  message: string;
}

/** Minimum on-premise prices for the smallest standard serving of each kind, in dollars. */
interface MinimumPrices {
  beer: number;
  wine: number;
  spirits: number;
  /** Whether the regulator's minimum includes sales tax. Printed prices usually don't. */
  taxIncluded: boolean;
}

export interface DrinkJurisdiction {
  country: "CA" | "US";
  region: string;
  /** Legal drinking age, printed on drink deals. */
  drinkingAge: number;
  /**
   * banned: time-limited drink discounts are illegal (a price may change only for a whole business
   * day or week). limited: allowed within the hours below. allowed: no time limit found.
   */
  happyHour: "banned" | "limited" | "allowed";
  /** A price must hold for this long, where happy hour is banned. */
  priceHolds?: "business day" | "week";
  minimum?: MinimumPrices;
  /** Discounted drinks must end by this hour (24h, local time). */
  discountEndsBy?: number;
  /** And may not start before this hour. */
  discountStartsAfter?: number;
  /** At most this many discounted hours a day. */
  maxDiscountHoursPerDay?: number;
  /** Quebec: a permit holder may not offer a discount off the usual price, so none is advertised. */
  noDiscountWording?: boolean;
  /** British Columbia: someone without a liquor licence may not advertise drink prices. */
  licenseeAdvertisesPrices?: boolean;
  /** When the entry was last checked against its sources. */
  checked: string;
}

const CHECKED = "2026-10-07";

// Canadian minimums are converted to the smallest serving a menu sells by the name: 12 oz (341 mL)
// of beer or draught, 5 oz (142 mL) of wine, 1 oz of spirits. A smaller pour at the same price
// would be over the line, but a price is only compared against the serving its word implies, so a
// "$4 pint" is never held to a 12 oz minimum it does not break.
const PROVINCES: Record<string, Omit<DrinkJurisdiction, "country" | "region" | "checked">> = {
  // O. Reg. 746/21 s. 26: $2.00 per 341 mL beer or 142 mL wine, $1.34 per 29 mL spirits, tax in.
  ON: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 2, wine: 2, spirits: 1.34, taxIncluded: true } },
  // Règlement P-9.1, r. 6, art. 9: no discount off the usual price. No on-premise minimum.
  QC: { drinkingAge: 18, happyHour: "allowed", noDiscountWording: true },
  // LCRB: $0.25/oz beer, $0.60/oz wine, $3.00/oz spirits, before tax. Draught of 50 oz+ is $0.20/oz.
  BC: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 3, wine: 3, spirits: 3, taxIncluded: false }, licenseeAdvertisesPrices: true },
  // AGLC's minimums changed on 9 June 2026 and were reversed on 22 June; not enforced until confirmed.
  AB: { drinkingAge: 18, happyHour: "allowed" },
  // SLGA, tax in: $2.25/oz spirits, $2.25 a 12 oz container, $0.16/oz draught, $0.35/oz wine.
  SK: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 1.92, wine: 1.75, spirits: 2.25, taxIncluded: true } },
  MB: { drinkingAge: 18, happyHour: "allowed" },
  // NB Reg. 84-265 s. 63.01, tax in, per oz: draught $0.11, wine $0.375, spirits $1.50.
  NB: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 1.32, wine: 1.87, spirits: 1.5, taxIncluded: true } },
  // N.S. Liquor Licensing Regulations s. 50A: $2.50 per standard serving, tax in.
  NS: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 2.5, wine: 2.5, spirits: 2.5, taxIncluded: true } },
  // Licensee Policy Manual: $3.50 with HST per 341 mL / 142 mL / 1.5 oz; 8 oz draught $1.25 + HST.
  PE: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 1.43, wine: 3.5, spirits: 2.43, taxIncluded: true } },
  // CNLR 1162/96 s. 36.1: $2.65 per standard serving, tax in.
  NL: { drinkingAge: 19, happyHour: "allowed", minimum: { beer: 2.65, wine: 2.65, spirits: 2.65, taxIncluded: true } },
  NT: { drinkingAge: 19, happyHour: "allowed" },
  NU: { drinkingAge: 19, happyHour: "allowed" },
  YT: { drinkingAge: 19, happyHour: "allowed" },
};

const STATES: Record<string, Omit<DrinkJurisdiction, "country" | "region" | "checked" | "drinkingAge">> = {
  MA: { happyHour: "banned", priceHolds: "week" }, // 204 CMR 4.03
  RI: { happyHour: "banned", priceHolds: "business day" }, // R.I.G.L. 3-7-26
  VT: { happyHour: "banned", priceHolds: "business day" },
  NC: { happyHour: "banned", priceHolds: "business day" }, // 14B NCAC 15B; H921 pending in 2026
  UT: { happyHour: "banned", priceHolds: "business day" }, // R82-1-104(6)(f)
  AK: { happyHour: "banned", priceHolds: "week" }, // AS 04.16.015
  IN: { happyHour: "limited", discountEndsBy: 21, maxDiscountHoursPerDay: 4 }, // since 1 July 2024
  IL: { happyHour: "limited", discountEndsBy: 22, maxDiscountHoursPerDay: 4 }, // 235 ILCS 5/6-28.5
  PA: { happyHour: "limited", discountEndsBy: 24, maxDiscountHoursPerDay: 4 },
  TX: { happyHour: "limited", discountEndsBy: 23 }, // 16 TAC 45.103
  VA: { happyHour: "limited", discountEndsBy: 21 }, // 3VAC5-50-160
  OH: { happyHour: "limited", discountEndsBy: 21 }, // OAC 4301:1-1-50
  AL: { happyHour: "limited", discountEndsBy: 21, discountStartsAfter: 10 }, // 20-X-6-.13
  SC: { happyHour: "limited", discountEndsBy: 20, discountStartsAfter: 16 }, // 61-6-4550
};

/** The rules for a province or state, or null where Radar holds none. */
export function drinkJurisdiction(country: string | null | undefined, region: string | null | undefined): DrinkJurisdiction | null {
  const nation = String(country || "").trim().toUpperCase();
  const code = regionCodeOf(region, nation);
  if (!code) return null;
  if (nation === "CA" && PROVINCES[code]) return { country: "CA", region: code, checked: CHECKED, ...PROVINCES[code] };
  if (nation === "US") return { country: "US", region: code, checked: CHECKED, drinkingAge: 21, ...(STATES[code] || { happyHour: "allowed" }) };
  return null;
}

/** States where a happy hour is illegal, for the national-chain check and the research routine. */
export const HAPPY_HOUR_BANNED_STATES = Object.entries(STATES).filter(([, rule]) => rule.happyHour === "banned").map(([code]) => code).sort();

// A location's region is a code ("ON") or a name ("Ontario"), depending on where it came from.
function regionCodeOf(region: string | null | undefined, country: string): string {
  const raw = String(region || "").replace(/\./g, "").trim();
  if (!raw) return "";
  if (raw.length === 2) return raw.toUpperCase();
  const name = raw.toLowerCase();
  const table = country === "CA" ? Object.keys(PROVINCES) : Object.keys(STATES).concat(US_CODES);
  for (const code of table) if (regionName(code, country).toLowerCase() === name) return code;
  if (country === "CA" && (name === "québec" || name === "quebec")) return "QC";
  return "";
}

const US_CODES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

/** Where a deal runs, as the check needs it. */
export interface DrinkRulePlace {
  region: string | null;
  country: string | null;
}

export interface DrinkRuleDeal {
  restaurant?: string | null;
  title?: string | null;
  price?: string | null;
  description?: string | null;
  category?: string | null;
  cuisine?: string | null;
  terms?: string | null;
  restrictions?: string | null;
  schedule?: string | null;
  source_url?: string | null;
  /** The restaurant's own website, to tell its own page from a directory. */
  website?: string | null;
  location_scope?: string | null;
  /** A national chain deal's country and states (restaurants.country and .footprint). */
  national_country?: string | null;
  national_regions?: readonly string[] | null;
}

// Sentence-sized pieces of copy, so a practice is tied to the drink it is about: "2 for 1 burgers.
// $6 pints" is a burger deal and a pint price, not a 2-for-1 on drinks.
const SEGMENT = /[.;!|•·\n]+|\s[-–—]\s|,\s(?=[A-Z$])/;
const DRINK_GENERIC = /(?<![\p{L}])(?:drinks?|beverages?|consos?|consommations?|verres?)(?![\p{L}])/iu;

const FREE = /(?<![\p{L}-])(?:free|complimentary|gratuit(?:e|s|es)?|offert(?:e|s|es)?|on\s+the\s+house)(?![\p{L}-])/giu;
const UNLIMITED = /(?<![\p{L}])(?:bottomless|unlimited|endless|à\s+volonté|a\s+volonte)(?![\p{L}])/giu;
// Unlimited drink by its own name, with no drink word needed beside it.
const UNLIMITED_ALONE = /(?<![\p{L}])(?:all[\s-]you[\s-]can[\s-]drink|drink\s+and\s+drown|open\s+bar)(?![\p{L}])/iu;
const MULTI = /(?<![\p{L}\d$])(?:(?:2|two|deux)\s*(?:for|4|pour)\s*(?:1|one|un)|buy\s+(?:one|1),?\s+get\s+(?:one|1)(?:\s+(?:free|half(?:\s+off)?))?|bogo|b1g1|second\s+(?:one|round)|2nd\s+(?:one|round))(?![\p{L}\d])/giu;
const SECOND_DRINK = /(?<![\p{L}])(?:second|2nd|every\s+(?:2nd|3rd|second|third))\s+(?:\p{L}+\s+)?(?:drink|beer|pint|glass|cocktail|round)s?(?![\p{L}])/iu;
const GAMES = /(?<![\p{L}])(?:beer\s+pong|flip\s+cup|drinking\s+(?:game|contest)s?|chug(?:ging)?\s+(?:contest|challenge)s?|keg\s+stands?|boat\s+races?|pub\s+crawls?)(?![\p{L}])/iu;
const GROUP = /(?<![\p{L}])(?:ladies['’]?\s+night|ladies\s+drink|girls\s+drink|women\s+drink|soirée\s+des\s+dames)(?![\p{L}])/iu;
const DISCOUNT = /(?:\d+\s?%\s*(?:off|de\s+rabais|de\s+réduction)|(?<![\p{L}])(?:half[\s-]price|half[\s-]off|demi[\s-]prix|moitié\s+prix|rabais|réduction|save|économisez|discount(?:ed)?)(?![\p{L}])|\$\s?\d+(?:[.,]\d{1,2})?\s+off|\d+(?:[.,]\d{1,2})?\s?\$\s+(?:de\s+)?(?:rabais|moins))/iu;
const FREE_EXEMPT = /(?<![\p{L}])(?:alcohol|sugar|gluten|dairy|nut|smoke|tax|fee|scent|cruelty|fat|duty)[\s-]free|free\s+(?:refills?|wi-?fi|parking|delivery|shipping|entry|admission|cover)/giu;

// Kinds of drink a printed price can be about, each with its smallest standard serving.
const BEER = "beers?|bières?|bieres?|pints?|pintes?|drafts?|draughts?|lagers?|ales?|ipas?|ciders?|cidres?|pilsners?|stouts?|tallboys?|tall\\s?cans?|seltzers?|coolers?|domestics?|bottles?\\s+of\\s+beer|bottled\\s+beers?|cans?\\s+of\\s+beer|buds?|coronas?|heinekens?|modelos?|molsons?|coors|labatts?|guinness";
const WINE = "wines?|vins?|vino|glass(?:es)?\\s+of\\s+(?:wine|red|white|rosé|rose|prosecco|bubbly)|verres?\\s+de\\s+vin|prosecco|cava|champagne|bubbly|ros[eé]|merlot|malbec|pinot(?:\\s+\\p{L}+)?|cabernet|chardonnay|riesling|sauvignon(?:\\s+blanc)?|sangria";
const SPIRITS = "shots?|shooters?|highballs?|rails?|well\\s+drinks?|bar\\s+rails?|cocktails?|caesars?(?!\\s+(?:salad|wrap|dressing))|margaritas?|martinis?|mojitos?|negronis?|spritz(?:es)?|mules?|palomas?|old\\s+fashioneds?|vodkas?|gins?|rums?|tequilas?|whiske?ys?|bourbons?|ryes?|scotch(?:es)?|mezcals?";
// Words that may sit between a price and its drink: "$5 house wine", "$4 domestic draft pints".
const BETWEEN = "(?:(?:house|domestic|import(?:ed)?|craft|local|draft|draught|bottled|canned|select|premium|feature(?:d)?|well|rail|red|white|tall|small|regular|sleeve|of|glass(?:es)?|de|la|le|les|pinte|verre|oz|\\d+\\s?oz|\\d+\\s?ml)\\s+){0,3}";
const AMOUNT = "(?:\\$\\s?(\\d{1,3}(?:[.,]\\d{1,2})?)|(\\d{1,3}(?:[.,]\\d{1,2})?)\\s?\\$)";
const PRICE_THEN_DRINK = new RegExp(`${AMOUNT}(?!\\s+off)(?:\\s+(?:each|ea))?\\s+${BETWEEN}(${BEER}|${WINE}|${SPIRITS})(?![\\p{L}])`, "giu");
const DRINK_THEN_PRICE = new RegExp(`(?<![\\p{L}])(${BEER}|${WINE}|${SPIRITS})(?:\\s*[:\\-–]\\s*|\\s+(?:for|at|just|only|pour|à)\\s+(?:just\\s+|only\\s+)?|\\s+)${AMOUNT}(?!\\s*(?:off|de\\s+rabais))`, "giu");

function kindOf(word: string): keyof Omit<MinimumPrices, "taxIncluded"> {
  const lower = word.toLowerCase();
  if (new RegExp(`^(?:${BEER})$`, "iu").test(lower)) return "beer";
  if (new RegExp(`^(?:${WINE})$`, "iu").test(lower)) return "wine";
  return "spirits";
}

/** Every price the copy prints for a drink, with the kind of drink it is for. */
export function printedDrinkPrices(copy: string): { amount: number; kind: "beer" | "wine" | "spirits"; text: string }[] {
  const found: { amount: number; kind: "beer" | "wine" | "spirits"; text: string; at: number }[] = [];
  for (const match of copy.matchAll(PRICE_THEN_DRINK)) {
    const amount = Number(String(match[1] ?? match[2]).replace(",", "."));
    found.push({ amount, kind: kindOf(match[3]), text: match[0].trim(), at: match.index ?? 0 });
  }
  for (const match of copy.matchAll(DRINK_THEN_PRICE)) {
    const amount = Number(String(match[2] ?? match[3]).replace(",", "."));
    const at = match.index ?? 0;
    if (found.some((entry) => Math.abs(entry.at - at) < 4)) continue;
    found.push({ amount, kind: kindOf(match[1]), text: match[0].trim(), at });
  }
  return found.filter((entry) => Number.isFinite(entry.amount)).map(({ amount, kind, text }) => ({ amount, kind, text }));
}

const DRINK_WORD = new RegExp(`(?<![\\p{L}])(?:${BEER}|${WINE}|${SPIRITS}|drinks?|beverages?|consos?|consommations?|alcohol|liquor|booze)(?![\\p{L}])`, "iu");
const JOINER = /(?<![\p{L}])(?:with|w\/|and|&|\+|plus|when|if|avec|et)(?![\p{L}])/iu;
// A practice about a soft drink or a kids' cup is not about alcohol.
const SOFT = /(?<![\p{L}])(?:soft|fountain|pop|soda|non[\s-]?alcoholic|kids?['’]?|coffee|tea|juice|refills?)(?![\p{L}])/iu;

/**
 * Whether a practice in this segment is about a drink: a drink word within a few words either side
 * of it. "Free appetizer with any drink purchase" and "2 for 1 wings, pint required" are food
 * offers; "free pint" and "pints 2 for 1" are not.
 */
function practiceOnDrink(segment: string, practice: RegExp): boolean {
  for (const match of segment.matchAll(practice)) {
    const at = match.index ?? 0;
    // Three words either side, cut at a joining word: in "2 for 1 wings with a pint" the offer
    // is the wings, and the pint belongs to the next clause.
    const after = segment.slice(at + match[0].length).trimStart().split(/\s+/).slice(0, 3).join(" ").split(JOINER)[0];
    const before = segment.slice(0, at).trimEnd().split(/\s+/).slice(-3).join(" ").split(JOINER).pop() || "";
    for (const side of [after, before]) {
      if (!DRINK_WORD.test(side) && !namesDrink(side)) continue;
      // "with any drink purchase" makes the drink a condition, not the thing given away.
      if (/purchase|order|achat/iu.test(side) || SOFT.test(side)) continue;
      return true;
    }
  }
  return false;
}

function segmentsAboutDrink(copy: string): string[] {
  return copy.split(SEGMENT).map((part) => part.trim()).filter((part) => part && (namesDrink(part) || DRINK_GENERIC.test(part)));
}

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + (mins || 0);
}

function hourLabel(hour: number): string {
  if (hour === 24 || hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour > 12 ? `${hour - 12} pm` : `${hour} am`;
}

function placeLabel(rule: DrinkJurisdiction): string {
  return regionName(rule.region, rule.country);
}

/** The printed copy of a deal, the same fields app/alcohol.ts reads. */
function printedCopy(deal: DrinkRuleDeal): string {
  return READABLE_FIELDS.filter((field) => field !== "cuisine" && field !== "category" && field !== "restaurant")
    .map((field) => deal[field])
    .filter(Boolean)
    .join(". ");
}

/**
 * Everything about a deal's drink advertising that breaks, or may break, the rules of the places
 * it runs. Empty for a deal that references no alcohol. `windows` are its schedule windows when
 * known; otherwise they are read from the schedule text.
 */
export function drinkRuleIssues(deal: DrinkRuleDeal, places: readonly DrinkRulePlace[], windows?: readonly ScheduleWindow[]): DrinkRuleIssue[] {
  if (!referencesAlcohol(deal)) return [];
  const issues: DrinkRuleIssue[] = [];
  const add = (issue: DrinkRuleIssue) => {
    if (!issues.some((entry) => entry.code === issue.code && entry.jurisdiction === issue.jurisdiction)) issues.push(issue);
  };
  const copy = printedCopy(deal);
  const drinkSegments = segmentsAboutDrink(copy);
  const happyHour = String(deal.category || "").trim().toLowerCase() === "happy hour" || /happy\s+hour|5\s*(?:à|a)\s*7/iu.test(copy);

  // Practices banned in most of the places Radar lists, and never safe to advertise.
  for (const segment of drinkSegments) {
    if (practiceOnDrink(segment.replace(FREE_EXEMPT, " "), FREE)) add({ code: "free_drinks", severity: "block", jurisdiction: "all", message: `Free drinks can't be advertised ("${segment}"). If the free item is food or a soft drink, say so.` });
    if (UNLIMITED_ALONE.test(segment) || practiceOnDrink(segment, UNLIMITED)) add({ code: "unlimited_drinks", severity: "block", jurisdiction: "all", message: `Unlimited, bottomless or all-you-can-drink alcohol is banned in most provinces and states ("${segment}").` });
    if (SECOND_DRINK.test(segment) || practiceOnDrink(segment, MULTI)) add({ code: "multi_drink_pricing", severity: "block", jurisdiction: "all", message: `2-for-1 and second-drink pricing is banned in Ontario, PEI and most states ("${segment}"). List the per-drink price instead.` });
    if (GROUP.test(segment)) add({ code: "group_pricing", severity: "block", jurisdiction: "all", message: `Drink prices for one group of customers (ladies' night) are banned in Ontario and several states ("${segment}").` });
  }
  if (GAMES.test(copy)) add({ code: "drinking_games", severity: "block", jurisdiction: "all", message: "Drinking games, contests and pub crawls can't be advertised." });

  const prices = printedDrinkPrices(copy);
  const regions = new Map<string, DrinkJurisdiction>();
  for (const place of places) {
    const rule = drinkJurisdiction(place.country, place.region);
    if (rule) regions.set(`${rule.country}-${rule.region}`, rule);
  }
  const schedule = windows && windows.length ? windows : parseScheduleText(deal.schedule);

  for (const [key, rule] of regions) {
    const where = placeLabel(rule);
    if (rule.happyHour === "banned") {
      if (happyHour) add({
        code: "happy_hour_banned", severity: "block", jurisdiction: key,
        message: namesDrink(copy)
          ? `${where} bans happy hours: a bar there can't lower drink prices for part of the day, or advertise doing so. Don't list it.`
          : `${where} bans advertising happy hours. If this is food only, take "happy hour" out of the title and change the category.`,
      });
      else add({ code: "full_day_pricing", severity: "check", jurisdiction: key, message: `${where} allows a drink price only if it holds for the whole ${rule.priceHolds}. Check the source says so.` });
    }
    if (rule.minimum) {
      for (const price of prices) {
        const floor = rule.minimum[price.kind];
        if (price.amount < floor) {
          add({
            code: "below_minimum",
            severity: "block",
            jurisdiction: key,
            message: `"${price.text}" is below ${where}'s minimum of $${floor.toFixed(2)} for ${price.kind === "spirits" ? "an ounce of spirits" : price.kind === "wine" ? "a 5 oz glass of wine" : "12 oz of beer"}${rule.minimum.taxIncluded ? " (tax included)" : ""}. Check the price and the serving size.`,
          });
        }
      }
    }
    if (rule.noDiscountWording && drinkSegments.some((segment) => DISCOUNT.test(segment)))
      add({ code: "discount_wording", severity: "block", jurisdiction: key, message: `${where} doesn't allow a bar to offer a discount on drinks. Print the 5 à 7 price itself ("$6 pints"), not a saving ("half price", "% off", "rabais").` });
    if (rule.licenseeAdvertisesPrices && (prices.length || happyHour) && sourceKind(deal.source_url, deal.website) !== "own")
      add({ code: "licensee_source", severity: "check", jurisdiction: key, message: `${where} lets only the licensee advertise drink prices, so prices there must be the venue's own, linked to its own page. This source isn't the venue's site; use its site or official account.` });
    if (rule.happyHour === "limited" && happyHour && schedule.length) {
      const late = rule.discountEndsBy !== undefined && schedule.some((window) => minutes(window.end) > rule.discountEndsBy! * 60 || minutes(window.end) < minutes(window.start));
      const early = rule.discountStartsAfter !== undefined && schedule.some((window) => minutes(window.start) < rule.discountStartsAfter! * 60);
      if (late || early) {
        const range = rule.discountStartsAfter !== undefined ? `between ${hourLabel(rule.discountStartsAfter)} and ${hourLabel(rule.discountEndsBy!)}` : `by ${hourLabel(rule.discountEndsBy!)}`;
        add({ code: "late_discount", severity: "check", jurisdiction: key, message: `${where} allows discounted drinks only ${range}. Check the hours; drinks after that are at the regular price.` });
      }
      if (rule.maxDiscountHoursPerDay !== undefined) {
        const byDay = new Map<string, number>();
        for (const window of schedule) for (const day of window.days) byDay.set(day, (byDay.get(day) || 0) + Math.max(0, minutes(window.end) - minutes(window.start)));
        if ([...byDay.values()].some((total) => total > rule.maxDiscountHoursPerDay! * 60))
          add({ code: "long_discount", severity: "check", jurisdiction: key, message: `${where} allows at most ${rule.maxDiscountHoursPerDay} hours of drink discounts a day. Check the hours.` });
      }
    }
  }

  // A national chain's deal is placed by its footprint, not by branches Radar holds.
  if (deal.location_scope === "national" && String(deal.national_country || "").toUpperCase() === "US" && happyHour) {
    const banned = (deal.national_regions || []).map((code) => code.toUpperCase()).filter((code) => HAPPY_HOUR_BANNED_STATES.includes(code));
    if (banned.length)
      add({ code: "national_banned_states", severity: "check", jurisdiction: "US", message: `This chain has branches in ${banned.join(", ")}, where happy hours are banned. The terms must say "participating locations", and the deal page says it isn't offered where state law prohibits it.` });
  }
  return issues;
}

/** The issues that stop a deal from going live. */
export function blockingDrinkIssues(issues: readonly DrinkRuleIssue[]): DrinkRuleIssue[] {
  return issues.filter((issue) => issue.severity === "block");
}

/**
 * Places, as SQL: every branch a deal is offered at, as one "region|country;..." string. The admin
 * reads deals in bulk, and one subquery per row is cheaper there than a second round trip.
 */
export const DEAL_PLACES_SQL = `(SELECT group_concat(DISTINCT COALESCE(l.region,'')||'|'||COALESCE(l.country,'')) FROM deal_locations dl JOIN restaurant_locations l ON l.id=dl.location_id WHERE dl.deal_id=d.id)`;

/** Reads DEAL_PLACES_SQL's string back into places. */
export function parseDealPlaces(value: string | null | undefined): DrinkRulePlace[] {
  return String(value || "").split(",").filter(Boolean).map((entry) => {
    const [region, country] = entry.split("|");
    return { region: region || null, country: country || null };
  });
}

/** A national chain's footprint ({"TN": 214, ...}) as region codes. */
export function footprintRegions(footprint: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(String(footprint || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).filter(([, count]) => Number(count) > 0).map(([code]) => code.toUpperCase());
  } catch {
    return [];
  }
}

/** One line per issue, for an API error or a warning. */
export function describeDrinkIssues(issues: readonly DrinkRuleIssue[]): string {
  return issues.map((issue) => issue.message).join(" ");
}

/**
 * One deal as drinkRuleIssues reads it, by id (bind it once). With its schedule windows as JSON,
 * since those, not the schedule text, decide when it runs.
 */
export const DRINK_RULE_DEAL_SQL = `SELECT d.id,d.restaurant,d.title,d.price,d.description,d.category,d.cuisine,d.terms,d.restrictions,d.schedule,d.source_url,d.location_scope,
    r.website,r.country national_country,r.footprint,${DEAL_PLACES_SQL} places,
    (SELECT json_group_array(json_object('days',json(s.days),'start',s.start_time,'end',s.end_time)) FROM deal_schedules s WHERE s.deal_id=d.id AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL) windows
  FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id
  WHERE d.id=? AND d.deleted_at IS NULL`;

/**
 * Every live deal, for the admin's list of live drink deals to fix. Every live deal rather than
 * the alcohol ones, since which are alcohol is decided in JS (app/alcohol.ts).
 */
export const DRINK_RULE_LIVE_SQL = DRINK_RULE_DEAL_SQL
  .replace("SELECT d.id,", "SELECT d.id,d.city,d.emoji,d.status,")
  .replace("WHERE d.id=? AND d.deleted_at IS NULL", "WHERE d.status='live' AND d.deleted_at IS NULL");

export interface DrinkRuleRow extends DrinkRuleDeal {
  id: string;
  footprint: string | null;
  places: string | null;
  windows: string | null;
}

/** drinkRuleIssues for a row read by DRINK_RULE_DEAL_SQL, with any fields about to change laid over it. */
export function drinkIssuesForRow(row: DrinkRuleRow, changes: Partial<DrinkRuleDeal> = {}): DrinkRuleIssue[] {
  let windows: ScheduleWindow[] = [];
  try {
    const parsed = JSON.parse(row.windows || "[]");
    if (Array.isArray(parsed)) windows = parsed.filter((entry) => entry && Array.isArray(entry.days) && entry.start && entry.end);
  } catch {
    windows = [];
  }
  // New schedule text means the windows are about to be re-checked against it; read the text.
  if (changes.schedule !== undefined && changes.schedule !== row.schedule) windows = [];
  return drinkRuleIssues(
    { ...row, ...changes, national_regions: footprintRegions(row.footprint) },
    parseDealPlaces(row.places),
    windows,
  );
}

/** The admin's list entry for a live deal that breaks, or may break, a drink rule. */
export interface DrinkRuleAlert {
  id: string;
  restaurant: string;
  title: string;
  city: string;
  emoji: string;
  issues: DrinkRuleIssue[];
}

/** At most this many in the admin's list; blocking ones first. */
export const DRINK_RULE_ALERT_LIMIT = 60;

// Each live deal's issues, kept beside the words they were read from. The check runs a dozen
// patterns over every live deal's copy - some fifty milliseconds of CPU across the catalogue, on a
// Worker allowed ten a request - and the workspace asks for it again whenever any deal changes
// (workspaceParts in app/api/admin/route.ts). The answer for a deal depends on nothing but its
// row, so a deal whose row reads as it did last time keeps its answer, and an edit re-reads the
// one deal it touched. Bounded to the catalogue's size: a deal that leaves the live list leaves
// the map at the next build.
const ISSUES_BY_DEAL = new Map<string, { row: string; issues: DrinkRuleIssue[] }>();
const rowKey = (row: DrinkRuleRow) => JSON.stringify([row.restaurant, row.title, row.price, row.description, row.category, row.cuisine, row.terms, row.restrictions, row.schedule, row.source_url, row.location_scope, row.website, row.national_country, row.footprint, row.places, row.windows]);

export function buildDrinkRuleAlerts(rows: readonly (DrinkRuleRow & { city?: string | null; emoji?: string | null })[]): DrinkRuleAlert[] {
  const alerts: DrinkRuleAlert[] = [];
  const seen = new Map<string, { row: string; issues: DrinkRuleIssue[] }>();
  for (const row of rows) {
    const key = rowKey(row);
    const known = ISSUES_BY_DEAL.get(row.id);
    const issues = known && known.row === key ? known.issues : drinkIssuesForRow(row);
    seen.set(row.id, { row: key, issues });
    if (issues.length) alerts.push({ id: row.id, restaurant: String(row.restaurant || ""), title: String(row.title || ""), city: String(row.city || ""), emoji: String(row.emoji || ""), issues });
  }
  ISSUES_BY_DEAL.clear();
  for (const [id, entry] of seen) ISSUES_BY_DEAL.set(id, entry);
  const blocks = (alert: DrinkRuleAlert) => alert.issues.some((issue) => issue.severity === "block") ? 0 : 1;
  return alerts.sort((a, b) => blocks(a) - blocks(b) || a.city.localeCompare(b.city) || a.restaurant.localeCompare(b.restaurant)).slice(0, DRINK_RULE_ALERT_LIMIT);
}
