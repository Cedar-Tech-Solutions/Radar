export type Coordinates = { latitude: number; longitude: number };

// Deliberately NOT imported from app/i18n/dealLabels.ts (which has the same content, reused by
// verification.ts and the deals API): tests/search.test.mjs loads this file by transpiling its
// source and importing it as a data: URL, which has no real filesystem path to resolve a
// relative import against. Keeping this file import-free is what makes that test setup work —
// see the comment there before adding a new import here. If these two ever drift, dealLabels.ts
// is the source of truth.
type AvailabilityLabels = {
  availableNow: (schedule: string) => string;
  laterToday: (schedule: string) => string;
  endedForToday: string;
  seeSchedule: string;
  availableToday: string;
  offerEnded: string;
  nextAvailable: (day: string) => string;
  scheduleUnavailable: string;
  weekdayNames: string[];
  // A clock time as each language writes it, and "until" one. A timed deal_schedules row states
  // its hours as "17:00", and quoting that straight into the line gave French and Spanish readers
  // an English "until 22:00" in the middle of their own sentence.
  clock: (hours: number, minutes: number) => string;
  until: (time: string) => string;
};

const AVAILABILITY_LABELS: Record<"en" | "fr" | "es", AvailabilityLabels> = {
  en: {
    availableNow: (schedule) => `Available now · ${schedule}`,
    laterToday: (schedule) => `Later today · ${schedule}`,
    endedForToday: "Ended for today",
    seeSchedule: "See schedule",
    availableToday: "Available today",
    offerEnded: "Offer ended",
    nextAvailable: (day) => `Next available ${day}`,
    scheduleUnavailable: "Schedule unavailable",
    weekdayNames: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    clock: (hours, minutes) => `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""} ${hours % 24 < 12 ? "AM" : "PM"}`,
    until: (time) => `until ${time}`,
  },
  fr: {
    availableNow: (schedule) => `Disponible maintenant · ${schedule}`,
    laterToday: (schedule) => `Plus tard aujourd'hui · ${schedule}`,
    endedForToday: "Terminé pour aujourd'hui",
    seeSchedule: "Voir l'horaire",
    availableToday: "Disponible aujourd'hui",
    offerEnded: "Offre terminée",
    nextAvailable: (day) => `Prochaine disponibilité ${day}`,
    scheduleUnavailable: "Horaire non disponible",
    weekdayNames: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    clock: (hours, minutes) => `${hours % 24} h${minutes ? ` ${String(minutes).padStart(2, "0")}` : ""}`,
    until: (time) => `jusqu'à ${time}`,
  },
  es: {
    availableNow: (schedule) => `Disponible ahora · ${schedule}`,
    laterToday: (schedule) => `Más tarde hoy · ${schedule}`,
    endedForToday: "Terminado por hoy",
    seeSchedule: "Ver horario",
    availableToday: "Disponible hoy",
    offerEnded: "Oferta finalizada",
    nextAvailable: (day) => `Próxima disponibilidad ${day}`,
    scheduleUnavailable: "Horario no disponible",
    weekdayNames: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
    clock: (hours, minutes) => `${hours % 24}:${String(minutes).padStart(2, "0")}`,
    until: (time) => `${time.startsWith("1:") ? "hasta la" : "hasta las"} ${time}`,
  },
};

function availabilityLabels(locale?: string | null): AvailabilityLabels {
  return AVAILABILITY_LABELS[locale === "fr" || locale === "es" ? locale : "en"];
}

export const searchAliases: Record<string, string[]> = {
  burger: ["burgers", "pub", "american"],
  burgers: ["burger", "pub", "american"],
  drink: ["drinks", "cocktail", "cocktails", "beer", "wine", "happy hour"],
  drinks: ["drink", "cocktail", "cocktails", "beer", "wine", "happy hour"],
  cheap: ["deal", "special", "discount", "value"],
  lunch: ["afternoon", "lunch", "food deal"],
  dinner: ["evening", "late", "dinner", "food deal"],
  wing: ["wings", "pub"],
  wings: ["wing", "pub"],
  oyster: ["oysters", "seafood"],
  oysters: ["oyster", "seafood"],
  cocktail: ["cocktails", "drinks", "bar"],
  cocktails: ["cocktail", "drinks", "bar"],
  patio: ["outdoor", "terrace", "terrasse"],
  terrace: ["patio", "outdoor", "terrasse"],
  terrasse: ["patio", "outdoor", "terrace"],
  rabais: ["deal", "discount", "special"],
  apero: ["happy hour", "cocktails", "drinks"],
};

// A keyword search normalizes every deal's search text, restaurant and title, several times over,
// on every request - and they are the same few hundred strings each time, straight out of the
// snapshot. Measured on production's catalogue that was most of a 19 ms search. Remembering each
// answer makes the repeat a map lookup. Bounded, and cleared rather than evicted: the working set is
// the catalogue plus what people type, which fits well inside the bound.
//
// Bounded by characters as well as entries: the keys include whatever a visitor typed, and 5,000
// entries of a sixteen-thousand-character `q` would be half an isolate's memory.
const normalizedCache = new Map<string, string>();
const NORMALIZED_CACHE_MAX = 5_000;
const NORMALIZED_CACHE_MAX_CHARS = 2_000_000;
let normalizedCacheChars = 0;

/**
 * The normalization itself, remembered nowhere. For text normalized once and kept - a deal's search
 * text, worked out when its shard of the snapshot is built - where remembering the answer would only
 * fill the cache below with strings no request will ask about again.
 */
export function foldSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeSearch(value: string) {
  const known = normalizedCache.get(value);
  if (known !== undefined) return known;
  const result = foldSearch(value);
  if (normalizedCache.size >= NORMALIZED_CACHE_MAX || normalizedCacheChars >= NORMALIZED_CACHE_MAX_CHARS) {
    normalizedCache.clear();
    normalizedCacheChars = 0;
  }
  normalizedCache.set(value, result);
  normalizedCacheChars += value.length + result.length;
  return result;
}

export function queryTokens(value: string) {
  return normalizeSearch(value).split(" ").filter((token) => token.length > 1);
}

// Matching is substring-based, which already makes a singular query find plural text: "taco"
// is inside "two-taco tuesday" AND inside "$3 tacos". The plural is what fails — "tacos" is
// inside neither — so a visitor searching the way people actually type ("tacos", "burgers",
// "wings") got nothing back unless that exact plural happened to be written on the deal.
//
// searchAliases patched this one word at a time (burger/burgers, wing/wings, oyster/oysters),
// which only ever covers the plurals someone thought to add: "tacos" was missing, and hid a
// live Ottawa deal from the most obvious search for it. Stripping the suffix instead fixes the
// whole class at once, so the alias table can go back to being about meaning ("burger" → "pub")
// rather than grammar.
//
// Only de-pluralizing, never pluralizing: the singular already matches both forms, so adding
// "s" would widen the net for nothing. Stems are length-guarded to keep the result a real word.
function tokenCandidates(token: string) {
  const candidates = [token];
  if (token.endsWith("es") && token.length >= 6) candidates.push(token.slice(0, -2));
  if (token.endsWith("s") && token.length >= 4) candidates.push(token.slice(0, -1));
  return candidates;
}

export function matchesQuery(searchDocument: string, query: string) {
  return matchesNormalizedQuery(normalizeSearch(searchDocument), query);
}

/**
 * matchesQuery for a document already normalized by foldSearch. The deals snapshot keeps every deal's
 * search text that way, so a search over a thousand deals runs no normalization at all over them -
 * it used to fold each deal's text on every request, which was most of what a keyword search cost.
 */
export function matchesNormalizedQuery(document: string, query: string) {
  const tokens = queryTokens(query);
  // queryTokens drops single-character tokens to keep multi-word searches from matching on
  // noise words — but a query that's ENTIRELY short tokens (a bare "5", a price like "$5")
  // then has nothing left to check, and `.every()` on an empty array is vacuously true, which
  // silently turned those searches into "match everything" instead of filtering by them.
  // Falling back to a plain substring check on the untokenized query keeps that content
  // actually searchable while leaving the normal multi-word path untouched.
  if (!tokens.length) {
    const normalizedQuery = normalizeSearch(query);
    return !normalizedQuery || document.includes(normalizedQuery);
  }
  return tokens.every((token) =>
    [...tokenCandidates(token), ...(searchAliases[token] || [])].some((candidate) =>
      document.includes(normalizeSearch(candidate)),
    ),
  );
}

export function relevanceScore(searchDocument: string, query: string, restaurant: string, title: string) {
  if (!query.trim()) return 0;
  return relevanceOfNormalized(normalizeSearch(searchDocument), query, restaurant, title);
}

/** relevanceScore for a document already normalized by foldSearch; see matchesNormalizedQuery. */
export function relevanceOfNormalized(document: string, query: string, restaurant: string, title: string) {
  if (!query.trim()) return 0;
  const normalizedQuery = normalizeSearch(query);
  const normalizedRestaurant = normalizeSearch(restaurant);
  const normalizedTitle = normalizeSearch(title);
  let score = 0;
  if (normalizedRestaurant === normalizedQuery) score += 1000;
  else if (normalizedRestaurant.startsWith(normalizedQuery)) score += 600;
  else if (normalizedRestaurant.includes(normalizedQuery)) score += 350;
  if (normalizedTitle === normalizedQuery) score += 500;
  else if (normalizedTitle.includes(normalizedQuery)) score += 250;
  for (const token of queryTokens(query)) {
    // The literal form still scores highest, so a deal that actually says "tacos" outranks one
    // that says "taco" — the de-pluralized stem only has to beat not being found at all.
    if (document.includes(token)) score += 40;
    else if (tokenCandidates(token).some((candidate) => document.includes(candidate))) score += 30;
    for (const alias of searchAliases[token] || []) if (document.includes(normalizeSearch(alias))) score += 10;
  }
  return score;
}

export function kmBetween(a: Coordinates, b: Coordinates) {
  const radius = 6371;
  const radians = (value: number) => (value * Math.PI) / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(haversine));
}

export function nextRadius(radius: number) {
  return [1, 2, 5, 10, 25, 50].find((candidate) => candidate > radius) || null;
}

export function parseList(values: string[]) {
  return Array.from(
    new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean)),
  );
}

export function safeLimit(value: string | null, fallback = 24) {
  return Math.max(1, Math.min(50, Number(value) || fallback));
}

export function safeCursor(value: string | null) {
  return Math.max(0, Number.parseInt(value || "0", 10) || 0);
}

export function optionalCoordinate(value: string | null, minimum: number, maximum: number) {
  if (value == null || value.trim() === "") return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : null;
}

// A weekday as a schedule writes it: "Tue", "Tues", "Tuesday", "Tuesdays", "Thurs". Whole words
// only. Matched as bare substrings, "mon" was found in "lemon" and "Edmonton", "sun" in "sunset"
// and "fri" in "fries", and each would have put the offer on a day it does not run.
const DAY_WORDS = ["sun(?:day)?", "mon(?:day)?", "tue(?:s(?:day)?)?", "wed(?:nesday)?", "thu(?:r(?:s(?:day)?)?)?", "fri(?:day)?", "sat(?:urday)?"];
const DAY_WORD = `(?<![a-z])(?:${DAY_WORDS.join("|")})s?(?![a-z])`;
const NAMES_DAY = DAY_WORDS.map((word) => new RegExp(`(?<![a-z])${word}s?(?![a-z])`));
const DAY_RANGE = new RegExp(`(${DAY_WORD})\\s*(?:[–—-]|to|through|thru)\\s*(${DAY_WORD})`, "g");

function dayRangeIncludesToday(value: string, weekday: number) {
  for (const match of value.matchAll(DAY_RANGE)) {
    const start = WEEKDAY_NAMES.indexOf(match[1].slice(0, 3)),end = WEEKDAY_NAMES.indexOf(match[2].slice(0, 3));
    if (start === -1 || end === -1) continue;
    if (start <= end ? weekday >= start && weekday <= end : weekday >= start || weekday <= end) return true;
  }
  return false;
}

// The words that name a group of days rather than one. "Every day" and "any time of day" named no
// day at all to the old reading, so twelve live offers written that way were never on today;
// "Weekends" named none either, and with a time range beside it the offer fell through to "every
// day" and read as on now on a Tuesday. "Nightly" is every night of the week, which is every day.
const EVERY_DAY_WORDS = "(?:(?<![a-z])(?:daily|every\\s*day|all\\s+week|any\\s*time|nightly|every\\s+night)(?![a-z])|(?<![\\w])(?:7|seven)\\s+days(?![a-z]))";
const WEEKDAYS_WORDS = "(?<![a-z])week(?:day|night)s?(?![a-z])";
const WEEKENDS_WORDS = "(?<![a-z])weekends?(?![a-z])";
const EVERY_DAY = new RegExp(EVERY_DAY_WORDS);
const WEEKDAYS_GROUP = new RegExp(WEEKDAYS_WORDS);
const WEEKENDS_GROUP = new RegExp(WEEKENDS_WORDS);
// Anything that names days, as one alternation so that "Mon-Fri" is read as one range before its
// two ends can be read as two days.
const DAY_SPEC = new RegExp(`${DAY_RANGE.source}|${DAY_WORD}|${EVERY_DAY_WORDS}|${WEEKDAYS_WORDS}|${WEEKENDS_WORDS}`, "g");
// What may sit between the parts of one list of days: "Thu, Fri & Sun", "Tue-Wed and Fri-Sat".
const DAY_LIST_GAP = /^[\s,&+/]*(?:(?:and|or)[\s,&+/]*)?$/;

// Time ranges in a free-text schedule: "3-6 PM", "4:30–6 pm", and the open-ended "9 PM-close",
// "5 PM-late" and "4 PM-midnight". Global, for matchAll.
const NUMERIC_RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
const CLOSE_RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[–—-]\s*(?:close|closing|late|midnight)/gi;
// A start with no end, "Tuesdays from 4 PM" and "Daily after 9 PM": on from then until close, the
// same as "4 PM-close". Read as no window at all, 35 live offers of this shape were "Available
// today" all day and never "Available now" inside their own hours. Not when it runs into a range,
// "from 5 PM-late", which CLOSE_RANGE reads already.
const FROM_TIME = /(?<![a-z])(?:from|after|starting(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?!\s*[–—-])/gi;
// And an end with no start, "Mon–Fri until 7 PM", "Daily, before 11 AM", "open-3 PM": on until
// then. The start is the start of the day; nothing in the text says when the doors open.
const UNTIL_TIME = /(?<![a-z])(?:until|till|til|before|open\s*[–—-])\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// An offer is tonight's when its hours reach past this, in minutes after midnight: "from about
// 3 PM on". A lunch that ends at 3 is not tonight's; a 3-6 happy hour and a wing night are.
const TONIGHT_FROM = 15 * 60;

// A promotion that runs on dates rather than weekdays: "Oct 6 only", "Sept 26-29", "Oct 30-Nov 2".
// National Taco Day is a date, and read as a weekly schedule it named no day, so the offer said
// "See schedule" on National Taco Day itself.
//
// Only a schedule that opens with its date is read this way. "Tuesdays through Oct 21" stays a
// Tuesday offer, and when a promotion stops is expires_at's job, not this one's.
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATED_SCHEDULE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*[–—-]\s*(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(\d{1,2}))?(?!\d)/;

/** The span a dated schedule names, as [start, end] keys of month * 100 + day, or null. */
export function scheduleDates(schedule: string): [number, number] | null {
  const match = schedule.trim().toLowerCase().match(DATED_SCHEDULE);
  if (!match) return null;
  const startMonth = MONTH_NAMES.indexOf(match[1]) + 1;
  const endMonth = match[3] ? MONTH_NAMES.indexOf(match[3]) + 1 : startMonth;
  const startDay = Number(match[2]);
  const endDay = match[4] ? Number(match[4]) : startDay;
  if (startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31) return null;
  return [startMonth * 100 + startDay, endMonth * 100 + endDay];
}

// Whether a month-day key falls in a span, including one that crosses the new year ("Dec 30-Jan 2").
function inDateSpan([start, end]: [number, number], key: number) {
  return start <= end ? key >= start && key <= end : key >= start || key <= end;
}

// Whether a lower-cased schedule runs on a weekday (0 = Sunday). The one reading of "which days"
// that the availability line, the order of a venue's week and the choice of a card's lead all
// share, so none of them can disagree with the "on today" printed beside it.
//
// A schedule that names no day at all but does state a time range ("3–6 PM") is an everyday
// offer written loosely, so treat it as one. Without a time range there is nothing to stand
// on — "See current official menu" stays unscheduled rather than claiming to be on today.
//
// Every clause counts: "Weekdays 8–11:30 AM, weekends 8 AM–2:30 PM" runs all week, where reading
// "weekday" alone put Father & Sons' weekend breakfast on no weekend at all.
function runsOnWeekday(value: string, weekday: number, hasTimeRange: boolean) {
  const everyDay = EVERY_DAY.test(value);
  const weekdays = WEEKDAYS_GROUP.test(value), weekends = WEEKENDS_GROUP.test(value);
  const namesADay = everyDay || weekdays || weekends || NAMES_DAY.some((name) => name.test(value));
  if (!namesADay) return hasTimeRange;
  return everyDay
    || (weekdays && weekday >= 1 && weekday <= 5)
    || (weekends && (weekday === 0 || weekday === 6))
    || dayRangeIncludesToday(value,weekday)
    || (weekday >= 0 && NAMES_DAY[weekday].test(value));
}

// Everything a free-text schedule says that does not depend on the clock, read once per distinct
// schedule. A deals request reads every deal's schedule - for its availability line, and again in
// the sort that lays a venue's offers out as a week, where weekRank ran twice per comparison - and
// it was reading the same few hundred strings with the same regexes thousands of times a request:
// 1.4 ms of it on the sort alone, on a Worker with a tight CPU budget. The catalog's schedules are
// the key space, so the map stays small; the cap is a backstop, not a policy.
type ParsedSchedule = {
  value: string;
  windows: Array<{ start: number; end: number }>;
  dates: [number, number] | null;
  runsOn: boolean[];
  weekdays: number[];
  rank: number;
  // The schedule from its first time on, which is how an availability line quotes the window:
  // "5-7 PM", or "from 4 PM" rather than a bare "4 PM" that reads as a range cut in half.
  window: string;
  // The windows that apply on each weekday, 0 = Sunday. Empty on a day it runs is all day.
  byDay: Array<Array<{ start: number; end: number }>>;
};
const PARSED_SCHEDULES = new Map<string, ParsedSchedule>();
const PARSED_SCHEDULES_MAX = 4096;

function minutesOfDay(hourText: string, minuteText: string | undefined, meridiem: string) {
  let hour = Number(hourText) % 12;
  if (meridiem.toLowerCase() === "pm") hour += 12;
  return hour * 60 + Number(minuteText || 0);
}

// Which windows apply on which days.
//
// Every window used to apply on every day the schedule named, so "Weekdays 8–11:30 AM, weekends
// 8 AM–2:30 PM" was on at noon on a Tuesday by the weekend's hours, and "Mon–Thu 4–7 PM; Fri 2–6
// PM" was on at 2 PM on a Monday by Friday's. Now a window belongs to the days named before it -
// the clause it is written in - and a day takes the windows of every clause that names it. A
// window written ahead of any day belongs to the first clause; with no clause at all, it is an
// everyday window, as a bare "3–6 PM" always was. A day whose clauses give it no hours at all -
// "nightly late hours", "Tue, all night" - is on all day, and one that has hours in one clause
// takes those hours rather than being made all day by a vaguer one beside it.
function windowsByDay(value: string, windows: Array<{ start: number; end: number; at: number }>) {
  const clauses: Array<{ days: Set<number>; at: number; end: number; windows: Array<{ start: number; end: number }> }> = [];
  for (const match of value.matchAll(DAY_SPEC)) {
    const spec = match[0], at = match.index ?? 0;
    const days = [0, 1, 2, 3, 4, 5, 6].filter((weekday) => runsOnWeekday(spec, weekday, false));
    const last = clauses[clauses.length - 1];
    // Days listed one after another with nothing but "," "&" or "and" between them are one clause:
    // "Thu, Fri & Sun 7-11 PM" is 7-11 on all three, not all day Thursday and Friday.
    if (last && DAY_LIST_GAP.test(value.slice(last.end, at))) {
      for (const day of days) last.days.add(day);
      last.end = at + spec.length;
    } else {
      clauses.push({ days: new Set(days), at, end: at + spec.length, windows: [] });
    }
  }
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map(() => [] as Array<{ start: number; end: number }>);
  if (!clauses.length) return everyDay.map(() => windows.map(({ start, end }) => ({ start, end })));
  for (const { start, end, at } of windows) {
    let owner = clauses[0];
    for (const clause of clauses) if (clause.at < at) owner = clause;
    owner.windows.push({ start, end });
  }
  return everyDay.map((_, weekday) => clauses.filter((clause) => clause.days.has(weekday)).flatMap((clause) => clause.windows));
}

function parseSchedule(schedule: string): ParsedSchedule {
  const known = PARSED_SCHEDULES.get(schedule);
  if (known) return known;
  const value = schedule.toLowerCase();
  const found: Array<{ start: number; end: number; at: number }> = [];
  for (const match of value.matchAll(NUMERIC_RANGE)) {
    const endMeridiem = match[6],startMeridiem = match[3] || endMeridiem;
    found.push({ start: minutesOfDay(match[1],match[2],startMeridiem), end: minutesOfDay(match[4],match[5],endMeridiem), at: match.index ?? 0 });
  }
  for (const match of value.matchAll(CLOSE_RANGE)) found.push({ start: minutesOfDay(match[1],match[2],match[3]), end: 24 * 60, at: match.index ?? 0 });
  // Not when the offer is also on all day somewhere: "in store after 8 PM, all day in the app" is
  // on all day to anyone with the app, and a window would call it not on yet at noon.
  if (!/(?<![a-z])all\s+day(?![a-z])/.test(value)) {
    for (const match of value.matchAll(FROM_TIME)) found.push({ start: minutesOfDay(match[1],match[2],match[3]), end: 24 * 60, at: match.index ?? 0 });
    for (const match of value.matchAll(UNTIL_TIME)) found.push({ start: 0, end: minutesOfDay(match[1],match[2],match[3]), at: match.index ?? 0 });
  }
  found.sort((a, b) => a.at - b.at);
  const windows = found.map(({ start, end }) => ({ start, end }));
  const byDay = windowsByDay(value, found);
  const runsOn = [0, 1, 2, 3, 4, 5, 6].map((weekday) => runsOnWeekday(value, weekday, windows.length > 0));
  const weekdays = [0, 1, 2, 3, 4, 5, 6].filter((weekday) => runsOn[weekday]);
  // A sort key that lays a venue's offers out as a week reads: the nightly specials Monday to
  // Sunday, then the offers that run most days - a daily happy hour belongs to no one night, and
  // filed under Monday it would push Monday's actual special down the list - then anything whose
  // schedule names no day at all.
  const rank = !weekdays.length ? 200
    : weekdays.length >= 5 ? 100 + weekdays.length
    : Math.min(...weekdays.map((day) => (day + 6) % 7)) * 10 + weekdays.length;
  const window = schedule.replace(/^.*?(?=(?:(?:from|after|until|till|before|starting(?:\s+at)?)\s+|open\s*[–—-]\s*)?\d)/i,"");
  const parsed = { value, windows, dates: scheduleDates(schedule), runsOn, weekdays, rank, window, byDay };
  if (PARSED_SCHEDULES.size >= PARSED_SCHEDULES_MAX) PARSED_SCHEDULES.clear();
  PARSED_SCHEDULES.set(schedule, parsed);
  return parsed;
}

// The weekdays a schedule runs on, 0 = Sunday. Unlike parseScheduleText in schedule-text.ts, which
// reads days only as part of a time window and so finds nothing in a bare "Wed" or "Daily", this
// needs no time at all - it is the availability line's own reading. A copy, because the parsed
// schedule is shared by every deal that has it.
export function scheduleWeekdays(schedule: string): number[] {
  return [...parseSchedule(schedule).weekdays];
}

// A weekday as a query parameter names one: "tue", "Tuesday", "tuesdays", or 0-6 from Sunday.
const WHOLE_DAY_WORDS = DAY_WORDS.map((word) => new RegExp(`^${word}s?$`));

/** The weekday a `day=` parameter names, 0 = Sunday, or null for anything that is not one. */
export function weekdayNumber(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (/^[0-6]$/.test(text)) return Number(text);
  const day = WEEKDAY_NAMES.indexOf(text.slice(0, 3));
  return day !== -1 && WHOLE_DAY_WORDS[day].test(text) ? day : null;
}

// deal_schedules `days` values, read once each: a request asking for one weekday tests every deal.
const ROW_DAYS = new Map<string, number[]>();

/**
 * Whether an offer runs on a weekday (0 = Sunday), by the reading its availability line uses: a
 * timed deal_schedules row when there is one it can use (see availabilityFromStructuredSchedule),
 * else the schedule text. The `day=` filter used to look for the day's name inside the text, so
 * "Daily", "Tue-Fri" and "Every day" never ran on a Wednesday: 42 live offers missed on Mondays
 * alone. A promotion on dates runs on the weekdays those dates fall on this year.
 */
export function offerRunsOn(weekday: number, schedule: string, daysValue?: string | null, startTime?: string | null, endTime?: string | null): boolean {
  if (daysValue && startTime && endTime && clockMinutes(startTime) != null && clockMinutes(endTime) != null) {
    let days = ROW_DAYS.get(daysValue);
    if (!days) {
      if (ROW_DAYS.size >= PARSED_SCHEDULES_MAX) ROW_DAYS.clear();
      ROW_DAYS.set(daysValue, days = scheduleRowDays(daysValue));
    }
    if (days.length) return days.includes(weekday);
  }
  const { dates, runsOn } = parseSchedule(String(schedule || ""));
  if (!dates) return runsOn[weekday] === true;
  // At most a week of days: past seven, every weekday has come round.
  const year = new Date().getUTCFullYear();
  let at = Date.UTC(year, Math.floor(dates[0] / 100) - 1, dates[0] % 100);
  for (let step = 0; step < 7; step++) {
    const date = new Date(at);
    if (date.getUTCDay() === weekday) return true;
    if ((date.getUTCMonth() + 1) * 100 + date.getUTCDate() === dates[1]) return false;
    at += 86_400_000;
  }
  return false;
}

// The days, hours and dates a schedule names, as one string two schedules can be compared by:
// "Tue" and "Tuesdays" are one schedule written twice, and so are "Mon-Fri 11 AM-3 PM" and
// "Weekdays 11am-3pm". A later close on Fridays is a different one.
export function scheduleShape(schedule: string): string {
  const { weekdays, windows, dates } = parseSchedule(schedule);
  return `${weekdays.join("")}|${windows.map((window) => `${window.start}-${window.end}`).join(",")}|${dates ? dates.join("-") : ""}`;
}

// The order a venue's week is laid out in - see the note in parseSchedule.
export function weekRank(schedule: string) {
  return parseSchedule(schedule).rank;
}

// Intl.DateTimeFormat instances, kept rather than rebuilt.
//
// This is the most expensive line in the request path and it does not look like one. Constructing
// a DateTimeFormat loads ICU locale and timezone data; doing it once per deal cost 20.8ms for a
// 133-deal response, more than the Worker's per-request CPU limit — so /api/deals and the homepage
// exceeded their limit on cold isolates, while cheap routes like /sitemap.xml served fine. Reusing
// the formatter instead takes the same 133 deals to 0.83ms.
//
// The map is keyed on timezone because that is the only part that varies: the locale is fixed at
// en-CA (these parts are parsed, never shown), and the options are constant. Unbounded growth is
// not a concern — the key space is the set of IANA zones the catalog actually uses, which is
// around six, and an isolate is recycled long before that could matter.
// Kept here rather than taken from app/formatters.ts, which does the same job for the rest of the
// site. This file is deliberately import-free — see the note at the top — so the duplication is
// the price of that, and it is a dozen lines against a test setup that loads this module by
// transpiling it in isolation.
const LOCAL_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
// The month and day are for a dated schedule - see scheduleDates() - and cost nothing extra: the
// parts come out of the same one formatToParts call.
const LOCAL_PARTS_OPTIONS: Intl.DateTimeFormatOptions = {weekday:"short",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"};

// The last answer for each zone, because a deals request asks with the same `date` for every deal
// in the catalog: 662 formatToParts calls a request, nearly all of them for one of six zones at one
// instant, were 4 ms of its CPU on their own. The parts are only ever read, so one object serves
// them all.
const LOCAL_PARTS_LAST = new Map<string, { at: number; parts: Record<string, string> }>();

function localPartsIn(date: Date, timezone?: string | null) {
  const zone = timezone || "America/Toronto";
  const at = date.getTime();
  const last = LOCAL_PARTS_LAST.get(zone);
  if (last && last.at === at) return last.parts;
  const parts = computeLocalParts(date, zone);
  LOCAL_PARTS_LAST.set(zone, { at, parts });
  return parts;
}

function computeLocalParts(date: Date, zone: string): Record<string, string> {
  let formatter = LOCAL_PARTS_FORMATTERS.get(zone);
  if (!formatter) {
    // A deal can carry a timezone this runtime does not recognize, and DateTimeFormat throws a
    // RangeError on one — which would fail the whole response over a single bad row. The fallback
    // is Toronto rather than UTC, because dropping the zone would quietly report the wrong day.
    try {
      formatter = new Intl.DateTimeFormat("en-CA",{timeZone:zone,...LOCAL_PARTS_OPTIONS});
    } catch {
      formatter = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",...LOCAL_PARTS_OPTIONS});
    }
    LOCAL_PARTS_FORMATTERS.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type,part.value]));
}

// `tonight` is whether the offer is still to come or on now today, with hours that reach into the
// evening: what the "Tonight" filter and tag mean, computed from the schedule in the same zone as
// the rest of the line rather than stored on the deal, where it said "Tonight" of a Monday wing
// night on every day of the week.
export function availabilityFromSchedule(schedule: string, date = new Date(), timezone?: string | null, locale?: string | null) {
  const labels = availabilityLabels(locale);
  const { value, windows: allWindows, dates, runsOn, window, byDay } = parseSchedule(schedule);
  const local = localPartsIn(date, timezone);
  const weekday = WEEKDAY_NAMES.indexOf(String(local.weekday).toLowerCase());
  // A dated promotion is on for its dates in the deal's own timezone, whatever weekday they fall on.
  const eligibleToday = dates
    ? inDateSpan(dates, Number(local.month) * 100 + Number(local.day))
    : weekday === -1 ? runsOnWeekday(value, weekday, allWindows.length > 0) : runsOn[weekday];
  if (!eligibleToday) return { eligibleToday:false,availableNow:false,phase:"unavailable" as const,label:labels.seeSchedule,tonight:false };
  // Today's hours - see windowsByDay. A dated promotion's hours are the same on each of its dates.
  const windows = dates || weekday === -1 ? allWindows : byDay[weekday];
  const evening = !windows.length || windows.some((w) => w.end > TONIGHT_FROM || w.end < w.start);
  // No time restriction at all ("Daily", "Weekdays") means the offer is open all day, same as
  // being inside a window right now — phase:"now" reflects that, distinct from availableNow
  // (which callers already use for the real-time "available_now" filter/sort and stays false
  // here since there's no window to have entered).
  if (!windows.length) return { eligibleToday:true,availableNow:false,phase:"now" as const,label:labels.availableToday,tonight:evening };
  const minutes = Number(local.hour) * 60 + Number(local.minute);
  const isAvailable = (w:{start:number;end:number}) => w.end >= w.start ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
  if (windows.some(isAvailable)) return {eligibleToday:true,availableNow:true,phase:"now" as const,label:labels.availableNow(window),tonight:evening};
  if (windows.some((w) => minutes < w.start)) return {eligibleToday:true,availableNow:false,phase:"upcoming" as const,label:labels.laterToday(window),tonight:evening};
  return {eligibleToday:true,availableNow:false,phase:"ended" as const,label:labels.endedForToday,tonight:false};
}

// A deal_schedules `days` value as weekday numbers, 0 = Sunday. The admin writes day names -
// '["Tue"]', '["mon","tue",...]' - and every row in the table is written that way. This used to
// read them as numbers, and Number("Tue") is NaN, so no timed row ever decided "on now": the
// schedule text did, for every deal, and a correction made only to a row's hours changed nothing.
// Names in any case, whole or short, and the numbers 0-6, as a JSON array or a comma list.
export function scheduleRowDays(daysValue: string | null): number[] {
  if (!daysValue) return [];
  let items: unknown[];
  try {
    const parsed = JSON.parse(daysValue);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = daysValue.split(",");
  }
  const days = new Set<number>();
  for (const item of items) {
    const text = String(item).trim().toLowerCase();
    const day = /^\d+$/.test(text) ? Number(text) : WEEKDAY_NAMES.indexOf(text.slice(0, 3));
    if (day >= 0 && day <= 6 && (/^\d+$/.test(text) || NAMES_DAY[day].test(text))) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** "17:00" as minutes after midnight, or null for anything that is not a clock time. */
function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours <= 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function availabilityFromStructuredSchedule(daysValue: string | null, startTime: string | null, endTime: string | null, timezone?: string | null, date = new Date(), locale?: string | null) {
  const labels = availabilityLabels(locale);
  if (!daysValue || !startTime || !endTime) return null;
  const days = scheduleRowDays(daysValue);
  const start = clockMinutes(startTime), end = clockMinutes(endTime);
  // A row that names no day, or whose hours are not clock times, says nothing the text does not,
  // and the text decides.
  if (!days.length || start == null || end == null) return null;
  const local = localPartsIn(date, timezone);
  const day = WEEKDAY_NAMES.indexOf(String(local.weekday).toLowerCase()),minutes = Number(local.hour) * 60 + Number(local.minute);
  if (day === -1) return null;
  const clock = (value: number) => labels.clock(Math.floor(value / 60), value % 60);
  const hours = `${clock(start)}–${clock(end)}`;
  const wraps = end <= start, today = days.includes(day);
  // A window past midnight is still the night before's: Tuesday 10 PM-2 AM is on at 1 AM Wednesday.
  const fromYesterday = wraps && days.includes((day + 6) % 7) && minutes < end;
  const evening = end > TONIGHT_FROM || wraps;
  if ((today && (wraps ? minutes >= start : minutes >= start && minutes < end)) || fromYesterday) {
    return {eligibleToday:true,availableNow:true,phase:"now" as const,label:labels.availableNow(labels.until(clock(end))),tonight:true};
  }
  if (today && minutes < start) return {eligibleToday:true,availableNow:false,phase:"upcoming" as const,label:labels.laterToday(hours),tonight:evening};
  // It ran today and is over, which is what the text reading says of the same hours. Telling a
  // reader at 11 PM on a Tuesday that a Tuesday offer is next available Tuesday said the opposite.
  if (today) return {eligibleToday:true,availableNow:false,phase:"ended" as const,label:labels.endedForToday,tonight:false};
  for (let offset=1;offset<=7;offset++) { const next = (day + offset) % 7; if (days.includes(next)) return {eligibleToday:false,availableNow:false,phase:"unavailable" as const,label:`${labels.nextAvailable(labels.weekdayNames[next])} · ${hours}`,tonight:false}; }
  return {eligibleToday:false,availableNow:false,phase:"unavailable" as const,label:labels.scheduleUnavailable,tonight:false};
}

export function safeReturnPath(value: string | null, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://radar.invalid");
    if (url.origin !== "https://radar.invalid") return fallback;
    // The output is checked as well as the input. Resolving dot segments can manufacture a
    // protocol-relative path out of one that did not start as one - "/.//evil.example",
    // "/%2e//evil.example" and "/a/..//evil.example" all come out as "//evil.example" - and an
    // href of "//evil.example" leaves the site.
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("//") || path.startsWith("/\\") ? fallback : path;
  } catch {
    return fallback;
  }
}
