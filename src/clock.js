#!/usr/bin/osascript -l JavaScript
// World Clock for Alfred: your cities' local times, a natural-language time converter and a meeting planner.
// Time-zone maths goes through NSTimeZone / NSCalendar (the macOS tz database), so DST is always right.
// Usage: osascript -l JavaScript clock.js clock [query]   (Script Filter: world clock, converter, add cities)
//        osascript -l JavaScript clock.js when [query]    (Script Filter: meeting planner)
//        osascript -l JavaScript clock.js act <arg>       (action: add, remove or rename a city)
ObjC.import("Foundation");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

// Test mode (any override set): never reopen Alfred, and never read the real saved cities outside the
// data folder the test passes. WC_NOW (ISO date) fixes the clock, WC_TZ the local zone, WC_LOCALE the region.
const TEST_MODE = ["WC_NOW", "WC_TZ", "WC_LOCALE", "WC_TEST"].some((k) => env(k, "") !== "");
const ALFRED = "com.runningwithcrayons.Alfred";
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const NOTICES = [];
let RERUN = null;

function nowMs() {
  const f = env("WC_NOW", "");
  if (f) {
    const t = Date.parse(f);
    if (!isNaN(t)) return t;
  }
  return Date.now();
}
const NOW = nowMs();

// ---------- helpers ----------

function dict(o) {
  return Object.assign(Object.create(null), o || {});
}
function readFile(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
// Atomic (temp file + rename): a Script Filter run can be killed at any point.
function writeFile(path, text) {
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}
function mkdirs(dir) {
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
}
function truthy(v, dflt) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (s === "") return dflt;
  return s === "1" || s === "true" || s === "yes";
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function wellFormed(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += "�";
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "�";
    else out += s[i];
  }
  return out;
}
// Display strings: no control or bidi-override characters.
function clean(s) {
  return typeof s === "string" ? wellFormed(s).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ") : s;
}

// Folding for search, mirrored by fold() in tools/make_cities.py: lower case, no accents, no punctuation.
const SPECIAL = dict({ ł: "l", Ł: "l", ø: "o", Ø: "o", æ: "ae", Æ: "ae", œ: "oe", Œ: "oe", ß: "ss", đ: "d", Đ: "d", ı: "i", ħ: "h", þ: "th", ð: "d" });
function fold(s) {
  let t = "";
  for (const c of String(s || "")) t += SPECIAL[c] || c;
  return t.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function info(title, subtitle, icon, extra) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon || "info"}.png` } }, extra || {});
}

function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

function output(items) {
  const all = stableUids(NOTICES.concat(items));
  for (const it of all) {
    it.title = clean(it.title);
    it.subtitle = clean(it.subtitle);
    for (const m of Object.values(it.mods || {})) m.subtitle = clean(m.subtitle);
  }
  const out = { skipknowledge: true, items: all };
  if (RERUN) out.rerun = RERUN;
  return JSON.stringify(out, (k, v) => (typeof v === "string" ? wellFormed(v) : v));
}

function kwClock() {
  return env("keyword_clock", "").trim() || "clock";
}

// ---------- settings ----------

function userLocale() {
  const id = env("WC_LOCALE", "");
  return id ? $.NSLocale.localeWithLocaleIdentifier(id) : $.NSLocale.currentLocale;
}
function patternLetters(p) {
  return String(p || "").replace(/'[^']*'/g, "");
}
// "Same as macOS": the short time style follows the 24-hour switch in System Settings; its hour symbol says
// which clock it uses (h/K = 12-hour, also with "B" day periods as in zh_TW, which have no "a").
function use12h() {
  const f = env("time_format", "system").trim();
  if (f === "12") return true;
  if (f === "24") return false;
  try {
    const df = $.NSDateFormatter.alloc.init;
    df.locale = userLocale();
    df.dateStyle = $.NSDateFormatterNoStyle;
    df.timeStyle = $.NSDateFormatterShortStyle;
    let p = patternLetters(df.dateFormat.js);
    if (!/[hHkK]/.test(p)) p = patternLetters($.NSDateFormatter.dateFormatFromTemplateOptionsLocale("j", 0, userLocale()).js);
    return /[hK]/.test(p);
  } catch (e) {
    return false;
  }
}
const H12 = use12h();

function monthFirst() {
  const f = env("date_format", "system").trim();
  if (f === "dmy") return false;
  if (f === "mdy") return true;
  try {
    const t = $.NSDateFormatter.dateFormatFromTemplateOptionsLocale("MMMd", 0, userLocale());
    if (t.isNil()) return false;
    const p = patternLetters(t.js);
    const m = p.search(/[ML]/), d = p.indexOf("d");
    return m >= 0 && d >= 0 && m < d;
  } catch (e) {
    return false;
  }
}
const MDY = monthFirst();

function userRegion() {
  const r = env("WC_REGION", "");
  if (r) return r.toUpperCase();
  try {
    const c = userLocale().countryCode;
    return c.isNil() ? "" : c.js.toUpperCase();
  } catch (e) {
    return "";
  }
}

function hourSetting(name, dflt) {
  const n = parseInt(env(name, ""), 10);
  return isNaN(n) || n < 0 || n > 24 ? dflt : n;
}
const WORK_START = hourSetting("work_start", 9);
const WORK_END = Math.max(hourSetting("work_end", 17), WORK_START + 1);
const SHOW_FLAGS = truthy(env("show_flags", ""), true);
const SORT_ADDED = env("sort_order", "offset").trim() === "added";

// ---------- time zones (NSTimeZone) ----------

// Names newer than the tz database of an older macOS fall back to their previous name.
const LEGACY = dict({
  "Europe/Kyiv": "Europe/Kiev", "Asia/Kolkata": "Asia/Calcutta", "Asia/Kathmandu": "Asia/Katmandu",
  "Asia/Yangon": "Asia/Rangoon", "America/Nuuk": "America/Godthab", "Pacific/Kanton": "Pacific/Enderbury",
  "Asia/Ho_Chi_Minh": "Asia/Saigon", "America/Ciudad_Juarez": "America/Ojinaga", "Atlantic/Faroe": "Atlantic/Faeroe",
  "Pacific/Pohnpei": "Pacific/Ponape", "Pacific/Chuuk": "Pacific/Truk", "America/Atikokan": "America/Coral_Harbour",
});
const ZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const TZ = new Map();
function zoneObj(name) {
  if (typeof name !== "string" || !ZONE_NAME_RE.test(name)) return null;
  if (TZ.has(name)) return TZ.get(name);
  let z = $.NSTimeZone.timeZoneWithName(name);
  if (z.isNil() && LEGACY[name]) z = $.NSTimeZone.timeZoneWithName(LEGACY[name]);
  const v = z.isNil() ? null : z;
  TZ.set(name, v);
  return v;
}
function nsdate(ms) {
  return $.NSDate.dateWithTimeIntervalSince1970(ms / 1000);
}
function offsetAt(p, ms) {
  if (p.fixed != null) return p.fixed;
  const z = zoneObj(p.zone);
  return z ? Number(z.secondsFromGMTForDate(nsdate(ms))) : 0;
}
function isDstAt(p, ms) {
  if (p.fixed != null) return false;
  const z = zoneObj(p.zone);
  return z ? !!z.isDaylightSavingTimeForDate(nsdate(ms)) : false;
}
function nextTransition(p, ms) {
  if (p.fixed != null) return null;
  const z = zoneObj(p.zone);
  if (!z) return null;
  const d = z.nextDaylightSavingTimeTransitionAfterDate(nsdate(ms));
  return d.isNil() ? null : Math.round(d.timeIntervalSince1970 * 1000);
}

// The wall clock of a place at an instant.
function wall(p, ms) {
  const off = offsetAt(p, ms);
  const t = ms + off * 1000;
  const d = new Date(t);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(), day: Math.floor(t / DAY), off };
}

let CAL = null;
// The instant of a wall-clock time in a place, via NSCalendar. `gap`: that time doesn't exist (clocks went
// forward; NSCalendar moves it forward). `second`: the later instant when the time happens twice.
function wallToInstant(p, y, mo, d, h, mi) {
  if (p.fixed != null) return { ms: Date.UTC(y, mo - 1, d, h, mi) - p.fixed * 1000, gap: false, second: null };
  if (!CAL) CAL = $.NSCalendar.alloc.initWithCalendarIdentifier($.NSCalendarIdentifierGregorian);
  CAL.timeZone = zoneObj(p.zone) || $.NSTimeZone.timeZoneForSecondsFromGMT(0);
  const c = $.NSDateComponents.alloc.init;
  c.year = y; c.month = mo; c.day = d; c.hour = h; c.minute = mi; c.second = 0;
  const date = CAL.dateFromComponents(c);
  let ms = Math.round(date.timeIntervalSince1970 * 1000);
  const w = wall(p, ms);
  const gap = w.h !== h || w.mi !== mi || w.d !== d;
  let second = null;
  if (!gap) {
    const asUtc = Date.UTC(y, mo - 1, d, h, mi);
    for (const probe of [ms + 3 * HOUR, ms - 3 * HOUR]) {
      const o = offsetAt(p, probe);
      if (o === w.off) continue;
      const other = asUtc - o * 1000;
      const ow = wall(p, other);
      if (other === ms || ow.h !== h || ow.mi !== mi || ow.d !== d) continue;
      // the time happens twice: report the earlier one first, whichever NSCalendar returned
      second = Math.max(other, ms);
      ms = Math.min(other, ms);
    }
  }
  return { ms, gap, second };
}
function addDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

// ---------- formatting ----------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtTime(w) {
  if (!H12) return `${pad(w.h)}:${pad(w.mi)}`;
  return `${w.h % 12 || 12}:${pad(w.mi)} ${w.h < 12 ? "AM" : "PM"}`;
}
// Compact, for the planner grid: "9am", "9:45pm" or "09:00"
function fmtShort(w) {
  if (!H12) return `${pad(w.h)}:${pad(w.mi)}`;
  return `${w.h % 12 || 12}${w.mi ? `:${pad(w.mi)}` : ""}${w.h < 12 ? "am" : "pm"}`;
}
function shortName(p) {
  const n = displayName(p);
  return n.length > 12 && !p.label ? n.split(/[\s,-]+/)[0] : n;
}
// "Tue 29 Sep", with the year when it isn't this year
function fmtDay(w) {
  const y = w.y !== undefined && w.y !== THIS_YEAR ? (MDY ? `, ${w.y}` : ` ${w.y}`) : "";
  return MDY ? `${DOW[w.dow]} ${MON[w.mo - 1]} ${w.d}${y}` : `${DOW[w.dow]} ${w.d} ${MON[w.mo - 1]}${y}`;
}
function fmtHm(sec, sep) {
  const a = Math.abs(sec), h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60);
  return m ? `${h}${sep}${pad(m)}` : `${h}`;
}
function fmtUtc(sec) {
  return sec === 0 ? "UTC" : `UTC${sec < 0 ? "−" : "+"}${fmtHm(sec, ":")}`;
}
function isoOffset(sec) {
  const a = Math.abs(sec);
  return `${sec < 0 ? "-" : "+"}${pad(Math.floor(a / 3600))}:${pad(Math.round((a % 3600) / 60))}`;
}
function fmtDiff(sec) {
  if (sec === 0) return "same time";
  const a = Math.abs(sec), h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60);
  return `${sec < 0 ? "−" : "+"}${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}`;
}
function fmtSpan(ms) {
  const m = Math.round(Math.abs(ms) / MIN);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return `${plural(d, "day")}${h ? ` ${h} h` : ""}`;
  if (h > 0) return `${h} h${mi ? ` ${mi} min` : ""}`;
  return `${mi} min`;
}
function relNow(ms) {
  const diff = ms - NOW;
  if (Math.abs(diff) < MIN) return "now";
  return diff > 0 ? `in ${fmtSpan(diff)}` : `${fmtSpan(diff)} ago`;
}
function iso(p, ms) {
  const w = wall(p, ms);
  const off = w.off === 0 && p.zone === "UTC" ? "Z" : isoOffset(w.off);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:00${off}`;
}
function flagOf(cc) {
  if (!SHOW_FLAGS || !cc || !/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65) + " ";
}

// Time-zone abbreviations for display. macOS only knows a few (it shows "GMT+2" for Berlin), so these come
// from a table: zone overrides first, then country + offset (+ DST flag where it matters), else "UTC+x".
const ZONE_ABBR = dict({
  "Australia/Lord_Howe": ["LHST", "LHDT"], "Pacific/Chatham": ["CHAST", "CHADT"], "America/Adak": ["HST", "HDT"],
  UTC: ["UTC", "UTC"], "Etc/UTC": ["UTC", "UTC"], GMT: ["GMT", "GMT"], "Etc/GMT": ["GMT", "GMT"],
  "Pacific/Guam": ["ChST", "ChST"], "Pacific/Saipan": ["ChST", "ChST"], "Pacific/Pago_Pago": ["SST", "SST"],
  "Pacific/Kiritimati": ["LINT", "LINT"], "America/Havana": ["CST", "CDT"],
});
const CET = "AL AD AT BA BE CH CZ DE DK ES FR HR HU IT LI LU ME MK MT MC NL NO PL RS SE SI SK SM VA XK GI SJ";
const EET = "BG CY EE FI GR LT LV MD RO UA LB PS AX";
const CC_ABBR = [
  ["US CA", -18000, 0, "EST"], ["US CA", -14400, 1, "EDT"], ["US CA MX", -21600, 0, "CST"], ["US CA", -18000, 1, "CDT"],
  ["US CA MX", -25200, 0, "MST"], ["US CA MX", -21600, 1, "MDT"], ["US CA MX", -28800, 0, "PST"], ["US CA MX", -25200, 1, "PDT"],
  ["MX JM PA KY", -18000, 0, "EST"], ["US", -32400, 0, "AKST"], ["US", -28800, 1, "AKDT"], ["US", -36000, 0, "HST"],
  ["CA BM PR VI DO BB TT AG AI AW BQ CW DM GD GP KN LC MF MQ MS SX VC VG", -14400, 0, "AST"], ["CA BM GL", -10800, 1, "ADT"],
  ["CA", -12600, 0, "NST"], ["CA", -9000, 1, "NDT"], ["GB GG IM JE", 0, null, "GMT"], ["GB GG IM JE", 3600, null, "BST"],
  ["IE", 0, null, "GMT"], ["IE", 3600, null, "IST"], ["IS GH SN CI ML BF GM GN GW LR SL TG SH MR", 0, null, "GMT"],
  ["PT ES FO", 0, 0, "WET"], ["PT ES FO", 3600, 1, "WEST"], [CET, 3600, 0, "CET"], [CET, 7200, 1, "CEST"], ["DZ TN", 3600, null, "CET"],
  [EET, 7200, 0, "EET"], [EET, 10800, 1, "EEST"], ["EG LY", 7200, 0, "EET"], ["EG", 10800, 1, "EEST"], ["RU BY", 10800, null, "MSK"],
  ["TR", 10800, null, "TRT"], ["IL", 7200, null, "IST"], ["IL", 10800, null, "IDT"], ["IN LK", 19800, null, "IST"],
  ["PK", 18000, null, "PKT"], ["BD", 21600, null, "BST"], ["NP", 20700, null, "NPT"], ["CN TW MO", 28800, null, "CST"],
  ["HK", 28800, null, "HKT"], ["SG", 28800, null, "SGT"], ["MY", 28800, null, "MYT"], ["PH", 28800, null, "PHT"],
  ["ID", 25200, null, "WIB"], ["ID", 28800, null, "WITA"], ["ID", 32400, null, "WIT"], ["TH VN KH LA", 25200, null, "ICT"],
  ["JP", 32400, null, "JST"], ["KR", 32400, null, "KST"], ["AU", 36000, 0, "AEST"], ["AU", 39600, 1, "AEDT"],
  ["AU", 34200, 0, "ACST"], ["AU", 37800, 1, "ACDT"], ["AU", 28800, null, "AWST"], ["NZ", 43200, 0, "NZST"], ["NZ", 46800, 1, "NZDT"],
  ["AE OM", 14400, null, "GST"], ["SA KW QA BH IQ YE", 10800, null, "AST"], ["IR", 12600, null, "IRST"], ["AF", 16200, null, "AFT"],
  ["MM", 23400, null, "MMT"], ["ZA LS SZ", 7200, null, "SAST"], ["NG AO BJ CF CG CM GA GQ NE TD CD", 3600, null, "WAT"],
  ["KE TZ UG ET SO DJ ER MG KM YT", 10800, null, "EAT"], ["MZ ZW ZM MW BW BI RW CD NA SS SD", 7200, null, "CAT"],
  ["BR", -10800, null, "BRT"], ["AR", -10800, null, "ART"], ["CL", -14400, 0, "CLT"], ["CL", -10800, 1, "CLST"],
  ["CO", -18000, null, "COT"], ["PE", -18000, null, "PET"], ["VE", -14400, null, "VET"], ["UY", -10800, null, "UYT"],
  ["CU", -18000, 0, "CST"], ["CU", -14400, 1, "CDT"],
];
function abbrAt(p, ms) {
  if (p.fixedAbbr) return p.fixedAbbr;
  if (p.fixed != null) return p.fixed === 0 ? "UTC" : null;
  const off = offsetAt(p, ms), dst = isDstAt(p, ms);
  const z = ZONE_ABBR[p.zone];
  if (z) return z[dst ? 1 : 0];
  const cc = p.cc || zoneCountry(p.zone);
  if (!cc) return null;
  for (const [ccs, o, d, a] of CC_ABBR) {
    if (o === off && (d === null || d === (dst ? 1 : 0)) && ` ${ccs} `.includes(` ${cc} `)) return a;
  }
  return null;
}
// "JST (UTC+9)" or "UTC+5:45"
function zoneLabel(p, ms) {
  const a = abbrAt(p, ms), u = fmtUtc(offsetAt(p, ms));
  return a && a !== u ? `${a} (${u})` : u;
}

// ---------- day and night ----------

// The sun's altitude in degrees (NOAA's low-precision formulas, good to a fraction of a degree).
function sunAltitude(lat, lon, ms) {
  const rad = Math.PI / 180;
  const d = ms / DAY + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon - ra) * rad;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
// "day", "night", "sunrise" or "sunset": from the sun's position when the place has coordinates,
// otherwise from the local hour.
function daylight(p, ms) {
  const w = wall(p, ms);
  if (typeof p.lat === "number" && typeof p.lon === "number" && isFinite(p.lat) && isFinite(p.lon)) {
    const alt = sunAltitude(p.lat, p.lon, ms);
    if (alt > 3) return "day";
    if (alt < -6) return "night";
    return sunAltitude(p.lat, p.lon, ms + 20 * MIN) > alt ? "sunrise" : "sunset";
  }
  const h = w.h + w.mi / 60;
  if (h >= 7 && h < 19) return "day";
  if (h >= 6 && h < 7) return "sunrise";
  if (h >= 19 && h < 20) return "sunset";
  return "night";
}

// ---------- data: cities and zones ----------

let CITIES = null, META = null;
function cities() {
  if (CITIES === null) CITIES = "\n" + (readFile("data/cities.tsv") || "");
  return CITIES;
}
function meta() {
  if (META === null) {
    try {
      META = JSON.parse(readFile("data/meta.json") || "{}");
    } catch (e) {
      META = {};
    }
    for (const k of ["zones", "countries", "admin1", "zonetab"]) if (!META[k]) META[k] = k === "zones" ? [] : {};
    META.countries = dict(META.countries);
    META.admin1 = dict(META.admin1);
    META.zonetab = dict(META.zonetab);
  }
  return META;
}
function zoneCountry(zone) {
  const z = meta().zonetab[zone];
  return z ? z[0] : "";
}
function countryName(cc) {
  return meta().countries[cc] || cc || "";
}
const DISPLAY = dict({ "New York City": "New York" });

// A line of cities.tsv (its start index) as a place.
function rowPlace(start) {
  const T = cities();
  let end = T.indexOf("\n", start);
  if (end < 0) end = T.length;
  const f = T.slice(start, end).split("\t");
  const m = meta();
  const zone = m.zones[+f[5]];
  const name = DISPLAY[f[1]] || f[1];
  const admin = f[3] ? m.admin1[`${f[2]}.${f[3]}`] || "" : "";
  const parts = [name];
  if (admin && fold(admin) !== fold(name)) parts.push(admin);
  if (f[2]) parts.push(countryName(f[2]));
  return { kind: "city", name, full: parts.join(", "), cc: f[2], admin, a1: f[3], pop: +f[4] || 0, zone, fixed: null, lat: +f[6], lon: +f[7], row: start };
}
function lineStart(T, i) {
  return T.lastIndexOf("\n", i - 1) + 1;
}
// Rows whose key is exactly `key`, most populous first.
function exactRows(key, limit) {
  const T = cities(), out = [], needle = `\n${key}\t`;
  let i = 0;
  while (out.length < limit && (i = T.indexOf(needle, i)) >= 0) {
    out.push(i + 1);
    i += needle.length;
  }
  return out;
}
// Rows with `key` among their alternate names (Bombay, München, Wien…).
function altRows(key, limit) {
  const T = cities(), out = [], needle = `|${key}|`;
  let i = 0;
  while (out.length < limit && (i = T.indexOf(needle, i)) >= 0) {
    const s = lineStart(T, i);
    if (T.lastIndexOf("\t", i) > s && T.slice(s, i).split("\t").length === 9) out.push(s);
    i += needle.length;
  }
  return out;
}
// Rows whose name, or a word in it, starts with `prefix`.
function prefixRows(prefix, limit) {
  const T = cities(), out = [];
  const re = new RegExp(`\\n(?:[^\\t\\n]* )?${esc(prefix)}[^\\t\\n]*\\t`, "g");
  let m;
  while (out.length < limit && (m = re.exec(T))) out.push(m.index + 1);
  return out;
}
function countryCities(cc, limit) {
  const T = cities(), out = [], seen = new Set();
  const re = new RegExp(`\\n[^\\t\\n]*\\t[^\\t\\n]*\\t${cc}\\t[^\\n]*`, "g");
  let m;
  while (out.length < limit && (m = re.exec(T))) {
    const p = rowPlace(m.index + 1);
    if (!seen.has(p.zone)) {
      seen.add(p.zone);
      out.push(p);
    }
  }
  return out;
}

// ---------- abbreviations people type ----------

// [name, zone, fixed offset in hours (null: follows the zone), regions that use this meaning first]
const ABBRS = dict({
  UTC: [["Coordinated Universal Time", "UTC", 0]], GMT: [["Greenwich Mean Time", "UTC", 0]],
  Z: [["UTC (Zulu)", "UTC", 0]], ZULU: [["UTC (Zulu)", "UTC", 0]], AOE: [["Anywhere on Earth", null, -12]],
  EST: [["US Eastern", "America/New_York", -5]], EDT: [["US Eastern", "America/New_York", -4]], ET: [["US Eastern", "America/New_York", null]],
  CST: [["US Central", "America/Chicago", -6], ["China Standard", "Asia/Shanghai", 8, "CN TW HK MO SG MY"], ["Cuba Standard", "America/Havana", -5, "CU"]],
  CDT: [["US Central", "America/Chicago", -5], ["Cuba Daylight", "America/Havana", -4, "CU"]], CT: [["US Central", "America/Chicago", null]],
  MST: [["US Mountain", "America/Denver", -7]], MDT: [["US Mountain", "America/Denver", -6]], MT: [["US Mountain", "America/Denver", null]],
  PST: [["US Pacific", "America/Los_Angeles", -8], ["Philippine Standard", "Asia/Manila", 8, "PH"]],
  PDT: [["US Pacific", "America/Los_Angeles", -7]], PT: [["US Pacific", "America/Los_Angeles", null]],
  AKST: [["Alaska", "America/Anchorage", -9]], AKDT: [["Alaska", "America/Anchorage", -8]],
  HST: [["Hawaii", "Pacific/Honolulu", -10]], HDT: [["Hawaii–Aleutian Daylight", "America/Adak", -9]],
  AST: [["Atlantic Standard", "America/Halifax", -4], ["Arabia Standard", "Asia/Riyadh", 3, "SA KW QA BH IQ YE AE OM JO"]],
  ADT: [["Atlantic Daylight", "America/Halifax", -3]], AT: [["Atlantic", "America/Halifax", null]],
  NST: [["Newfoundland", "America/St_Johns", -3.5]], NDT: [["Newfoundland", "America/St_Johns", -2.5]],
  BST: [["British Summer", "Europe/London", 1], ["Bangladesh Standard", "Asia/Dhaka", 6, "BD"]],
  IST: [["India Standard", "Asia/Kolkata", 5.5], ["Irish Standard", "Europe/Dublin", 1, "IE GB"], ["Israel Standard", "Asia/Jerusalem", 2, "IL PS"]],
  IDT: [["Israel Daylight", "Asia/Jerusalem", 3]], WET: [["Western European", "Europe/Lisbon", 0]], WEST: [["Western European Summer", "Europe/Lisbon", 1]],
  CET: [["Central European", "Europe/Paris", 1]], CEST: [["Central European Summer", "Europe/Paris", 2]],
  EET: [["Eastern European", "Europe/Athens", 2]], EEST: [["Eastern European Summer", "Europe/Athens", 3]],
  MSK: [["Moscow", "Europe/Moscow", 3]], TRT: [["Turkey", "Europe/Istanbul", 3]],
  GST: [["Gulf Standard", "Asia/Dubai", 4], ["South Georgia", "Atlantic/South_Georgia", -2, "GS"]],
  IRST: [["Iran Standard", "Asia/Tehran", 3.5]], AFT: [["Afghanistan", "Asia/Kabul", 4.5]], PKT: [["Pakistan Standard", "Asia/Karachi", 5]],
  NPT: [["Nepal", "Asia/Kathmandu", 5.75]], MMT: [["Myanmar", "Asia/Yangon", 6.5]], ICT: [["Indochina", "Asia/Bangkok", 7]],
  WIB: [["Western Indonesia", "Asia/Jakarta", 7]], WITA: [["Central Indonesia", "Asia/Makassar", 8]], WIT: [["Eastern Indonesia", "Asia/Jayapura", 9]],
  SGT: [["Singapore", "Asia/Singapore", 8]], HKT: [["Hong Kong", "Asia/Hong_Kong", 8]], MYT: [["Malaysia", "Asia/Kuala_Lumpur", 8]],
  PHT: [["Philippine", "Asia/Manila", 8]], AWST: [["Australian Western", "Australia/Perth", 8]], JST: [["Japan Standard", "Asia/Tokyo", 9]],
  KST: [["Korea Standard", "Asia/Seoul", 9]], ACST: [["Australian Central", "Australia/Adelaide", 9.5]], ACDT: [["Australian Central Daylight", "Australia/Adelaide", 10.5]],
  AEST: [["Australian Eastern", "Australia/Sydney", 10]], AEDT: [["Australian Eastern Daylight", "Australia/Sydney", 11]], AET: [["Australian Eastern", "Australia/Sydney", null]],
  LHST: [["Lord Howe", "Australia/Lord_Howe", 10.5]], NZST: [["New Zealand", "Pacific/Auckland", 12]], NZDT: [["New Zealand Daylight", "Pacific/Auckland", 13]],
  CHAST: [["Chatham", "Pacific/Chatham", 12.75]], CHADT: [["Chatham Daylight", "Pacific/Chatham", 13.75]],
  SAST: [["South African", "Africa/Johannesburg", 2]], WAT: [["West Africa", "Africa/Lagos", 1]], CAT: [["Central Africa", "Africa/Maputo", 2]],
  EAT: [["East Africa", "Africa/Nairobi", 3]], BRT: [["Brasília", "America/Sao_Paulo", -3]], ART: [["Argentina", "America/Argentina/Buenos_Aires", -3]],
  CLT: [["Chile", "America/Santiago", -4]], COT: [["Colombia", "America/Bogota", -5]], PET: [["Peru", "America/Lima", -5]],
  SST: [["Samoa", "Pacific/Pago_Pago", -11], ["Singapore Standard", "Asia/Singapore", 8, "SG MY"]], CHST: [["Chamorro", "Pacific/Guam", 10]],
  LINT: [["Line Islands", "Pacific/Kiritimati", 14]],
});
// Abbreviations that are also English words only count in capitals ("3pm EAT", not "eat").
const CAPS_ONLY = new Set(["ART", "CAT", "EAT", "PET", "WAT", "WET", "AFT", "COT", "WIT", "AT", "WEST", "MART", "Z"]);

function abbrPlaces(word) {
  const up = word.toUpperCase();
  const list = ABBRS[up];
  if (!list) return null;
  if (CAPS_ONLY.has(up) && word !== up) return null;
  const region = userRegion() || zoneCountry(LOCAL.zone);
  const places = list.map(([name, zone, hours, regions]) => {
    const fixed = hours == null ? null : Math.round(hours * 3600);
    const p = zone === null
      ? { kind: "abbr", name, full: `${name} (${fmtUtc(fixed)})`, zone: null, fixed, fixedAbbr: up === "AOE" ? "AoE" : up, cc: "" }
      : { kind: "abbr", name: `${name} time`, full: `${name} time`, zone, fixed: null, cc: zoneCountry(zone) };
    if (zone === "UTC") Object.assign(p, { name: up === "GMT" ? "GMT" : "UTC", full: name, zone: "UTC", fixed: 0, fixedAbbr: up === "GMT" ? "GMT" : "UTC" });
    p.abbr = up;
    p.noFlag = true; // CET isn't French, even though Paris stands in for it
    p.strict = fixed;
    p.regions = regions || "";
    const zt = zone && meta().zonetab[zone];
    if (zt) Object.assign(p, { lat: zt[1], lon: zt[2] });
    return p;
  });
  const i = places.findIndex((p) => region && ` ${p.regions} `.includes(` ${region} `));
  if (i > 0) places.unshift(places.splice(i, 1)[0]);
  return places;
}

// ---------- places ----------

const COUNTRY_ALIAS = dict({
  usa: "US", us: "US", "united states of america": "US", america: "US", uk: "GB", britain: "GB", "great britain": "GB",
  england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", uae: "AE", emirates: "AE", holland: "NL",
  korea: "KR", "south korea": "KR", "north korea": "KP", russia: "RU", czechia: "CZ", "czech republic": "CZ",
  vietnam: "VN", "ivory coast": "CI", turkey: "TR", turkiye: "TR", iran: "IR", syria: "SY", laos: "LA", taiwan: "TW",
  "hong kong": "HK", macau: "MO", bolivia: "BO", venezuela: "VE", tanzania: "TZ", moldova: "MD", "the netherlands": "NL",
});
const PLACE_ALIAS = dict({
  nyc: "new york city", ny: "new york city", "new york": "new york city", sf: "san francisco", "san fran": "san francisco",
  la: "los angeles", dc: "washington", "washington dc": "washington", "washington d c": "washington", hk: "hong kong",
  kl: "kuala lumpur", bombay: "mumbai", calcutta: "kolkata", madras: "chennai", saigon: "ho chi minh city",
  hcmc: "ho chi minh city", peking: "beijing", kiev: "kyiv", philly: "philadelphia", vegas: "las vegas",
  "st petersburg": "saint petersburg", bengaluru: "bengaluru", bangalore: "bengaluru", gurgaon: "gurugram",
});
function countryByName(key) {
  if (COUNTRY_ALIAS[key]) return COUNTRY_ALIAS[key];
  const m = meta();
  if (!m._countryFold) {
    m._countryFold = new Map();
    for (const [cc, n] of Object.entries(m.countries)) m._countryFold.set(fold(n), cc);
  }
  return m._countryFold.get(key) || null;
}

let LOCAL = null;
function zonePlace(zone) {
  const zt = meta().zonetab[zone];
  const name = zone === "UTC" ? "UTC" : zone.split("/").pop().replace(/_/g, " ");
  return { kind: "zone", name: DISPLAY[name] || name, full: zone, zone, fixed: null, cc: zt ? zt[0] : "", lat: zt ? zt[1] : null, lon: zt ? zt[2] : null };
}
function localPlace() {
  let z = env("WC_TZ", "");
  if (!z || !zoneObj(z)) z = $.NSTimeZone.localTimeZone.name.js;
  const p = zonePlace(z);
  p.here = true;
  return p;
}
LOCAL = localPlace();
const THIS_YEAR = wall(LOCAL, NOW).y;

function isHereWord(key) {
  return key === "here" || key === "local" || key === "me" || key === "my time" || key === "local time" || key === "my place";
}

let KNOWN = null;
function knownZone(phrase) {
  if (!KNOWN) {
    KNOWN = new Map();
    const arr = $.NSTimeZone.knownTimeZoneNames.js;
    for (const n of arr) KNOWN.set(fold(n.js), n.js);
    for (const [n, old] of Object.entries(LEGACY)) if (KNOWN.has(fold(old)) && !KNOWN.has(fold(n))) KNOWN.set(fold(n), n);
  }
  return KNOWN.get(fold(phrase)) || null;
}

// "UTC+5:30", "GMT-3", "+0530"
function offsetPlace(phrase) {
  const m = /^(?:(utc|gmt)\s*)?([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(phrase.trim());
  if (!m) return null;
  const h = +m[3], mi = +(m[4] || 0);
  if (h > 14 || mi > 59 || (!m[1] && !m[4] && phrase.trim().length < 3)) return null;
  const fixed = (m[2] === "+" ? 1 : -1) * (h * 3600 + mi * 60);
  if (Math.abs(fixed) > 14 * 3600) return null;
  const label = fmtUtc(fixed);
  return { kind: "offset", name: label, full: label, zone: null, fixed, fixedAbbr: label, cc: "" };
}

// Does `q` (folded) qualify a city: its country, state (or US state code) or country code?
function qualifies(p, q) {
  if (!q) return true;
  if (p.cc && (q === p.cc.toLowerCase() || COUNTRY_ALIAS[q] === p.cc || fold(countryName(p.cc)) === q)) return true;
  if (p.admin && fold(p.admin) === q) return true;
  return p.cc === "US" && p.a1 && p.a1.toLowerCase() === q;
}

function favByKey(key) {
  return FAVS.find((f) => fold(f.label || "") === key || fold(f.name) === key) || null;
}

// One phrase → the best place (with `alts`: other meanings), or null.
function resolvePhrase(phrase) {
  const raw = phrase.trim();
  if (!raw) return null;
  const key = fold(raw);
  if (isHereWord(key)) return LOCAL;
  const ab = /^[A-Za-z]{1,5}$/.test(raw) ? abbrPlaces(raw) : null;
  if (ab) return Object.assign({}, ab[0], { alts: ab.slice(1) });
  const off = offsetPlace(raw);
  if (off) return off;
  if (!key) return null;
  const fav = favByKey(key);
  if (fav) return fav;
  if (/\//.test(raw) || key === "utc") {
    const z = knownZone(raw);
    if (z) return zonePlace(z);
  }
  const name = PLACE_ALIAS[key] || key;
  // A zone's own place (Chatham, Lord Howe, Kiritimati: population 0 in the data) wins over namesakes
  let rows = exactRows(name, 12);
  const zi = rows.findIndex((r) => rowPlace(r).pop === 0);
  if (zi > 0) rows.unshift(rows.splice(zi, 1)[0]);
  if (!rows.length && /\//.test(raw) === false) {
    const z = knownZone(raw);
    if (z && z.includes("/")) return zonePlace(z);
  }
  if (rows.length) return withCityAlts(rowPlace(rows[0]), rows.slice(1));
  const cc = countryByName(key);
  if (cc) {
    const list = countryCities(cc, 8);
    if (list.length) return Object.assign({}, list[0], { viaCountry: countryName(cc), alts: list.slice(1) });
  }
  rows = altRows(name, 1);
  if (rows.length) return rowPlace(rows[0]);
  // "Portland, Maine", "Paris Texas", "London ON"
  const words = raw.split(/[\s,]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 1; i--) {
    const head = fold(words.slice(0, i).join(" ")), q = fold(words.slice(i).join(" "));
    const cand = exactRows(PLACE_ALIAS[head] || head, 60).concat(altRows(head, 20)).map(rowPlace).filter((p) => qualifies(p, q));
    if (cand.length) return Object.assign(cand[0], { qualified: true });
  }
  // A state or province: its biggest city
  for (const code of adminCodes(key)) {
    const [c, a] = code.split(".");
    const re = new RegExp(`\\n[^\\t\\n]*\\t[^\\t\\n]*\\t${esc(c)}\\t${esc(a)}\\t`);
    const hit = re.exec(cities());
    if (hit) return Object.assign(rowPlace(hit.index + 1), { viaAdmin: meta().admin1[code] });
  }
  return null;
}
// State and province codes ("US.UT") by folded name, built once per run.
let ADMIN_FOLD = null;
function adminCodes(key) {
  if (!ADMIN_FOLD) {
    ADMIN_FOLD = new Map();
    for (const [code, n] of Object.entries(meta().admin1)) {
      const k = fold(n);
      if (!ADMIN_FOLD.has(k)) ADMIN_FOLD.set(k, []);
      ADMIN_FOLD.get(k).push(code);
    }
  }
  return ADMIN_FOLD.get(key) || [];
}
// Other cities with the same name (Portland, Oregon / Portland, Maine) as alternatives.
function withCityAlts(p, rest) {
  // only namesakes big enough to be meant (Portland, Maine: yes; Sydney, Nova Scotia: no)
  const others = rest.slice(0, 6).map(rowPlace).filter((o) => o.pop >= 500000 || o.pop >= p.pop / 10);
  return others.length ? Object.assign(p, { alts: others.slice(0, 3), altKind: "city" }) : p;
}
// Like resolvePhrase, falling back to the most populous city whose name starts with the phrase.
function resolveLoose(phrase) {
  const p = resolvePhrase(phrase);
  if (p) return p;
  const key = fold(phrase);
  if (key.length < 3) return null;
  const rows = prefixRows(key, 1);
  return rows.length ? Object.assign(rowPlace(rows[0]), { guessed: true }) : null;
}

// Several places in a row: "London NYC Tokyo", "Tokyo, London and Paris", "Portland Maine Tokyo".
function segmentPlaces(text) {
  const chunks = text.split(/\s*[,;]\s*|\s+(?:and|&|\+)\s+/i).map((s) => s.trim()).filter(Boolean);
  const places = [], unknown = [];
  for (let c = 0; c < chunks.length; c++) {
    if (c + 1 < chunks.length) {
      const joined = resolvePhrase(`${chunks[c]}, ${chunks[c + 1]}`);
      if (joined && joined.qualified) {
        places.push(Object.assign({}, joined, { token: `${chunks[c]}, ${chunks[c + 1]}` }));
        c++;
        continue;
      }
    }
    const words = chunks[c].split(/\s+/);
    let i = 0;
    while (i < words.length) {
      let found = null, j;
      for (j = Math.min(words.length, i + 5); j > i; j--) {
        found = resolvePhrase(words.slice(i, j).join(" "));
        if (found) break;
      }
      if (!found && c === chunks.length - 1) {
        // the rest may be a name still being typed ("London Tok")
        found = resolveLoose(words.slice(i).join(" "));
        if (found) j = words.length;
      }
      if (!found) j = i + 1;
      // a copy: `found` may be a saved city or the local place
      if (found) places.push(Object.assign({}, found, { token: words.slice(i, j).join(" ") }));
      else unknown.push(words[i]);
      i = j;
    }
  }
  return { places, unknown };
}

// ---------- saved cities ----------

function dataDir() {
  let d = env("alfred_workflow_data", "");
  if (!d) d = `${$.NSTemporaryDirectory().js}alfred-world-clock${TEST_MODE ? "-test" : ""}`;
  return d;
}
function favsPath() {
  return `${dataDir()}/cities.json`;
}
const DEFAULT_FAVS = [
  { name: "New York", cc: "US", zone: "America/New_York", lat: 40.71, lon: -74.01, admin: "New York" },
  { name: "London", cc: "GB", zone: "Europe/London", lat: 51.51, lon: -0.13, admin: "England" },
  { name: "Tokyo", cc: "JP", zone: "Asia/Tokyo", lat: 35.69, lon: 139.69 },
];
// A saved city, checked: it comes from a file the user could edit.
function sanitizeFav(o) {
  if (!o || typeof o !== "object" || typeof o.name !== "string" || !o.name.trim()) return null;
  const f = { kind: "fav", name: o.name.slice(0, 80), cc: typeof o.cc === "string" && /^[A-Z]{2}$/.test(o.cc) ? o.cc : "" };
  if (typeof o.zone === "string" && zoneObj(o.zone)) {
    f.zone = o.zone;
    f.fixed = null;
  } else if (typeof o.fixed === "number" && isFinite(o.fixed) && Math.abs(o.fixed) <= 14 * 3600) {
    f.zone = null;
    f.fixed = Math.round(o.fixed);
    f.fixedAbbr = typeof o.fixedAbbr === "string" ? o.fixedAbbr.slice(0, 12) : fmtUtc(f.fixed);
  } else return null;
  if (typeof o.lat === "number" && typeof o.lon === "number" && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180) {
    f.lat = o.lat;
    f.lon = o.lon;
  }
  if (typeof o.admin === "string") f.admin = o.admin.slice(0, 80);
  if (typeof o.label === "string" && o.label.trim()) f.label = o.label.trim().slice(0, 40);
  f.full = [f.name, f.admin && f.admin !== f.name ? f.admin : "", f.cc ? countryNameLazy(f.cc) : ""].filter(Boolean).join(", ");
  return f;
}
// Country names without loading meta.json on the fast path (the world clock only needs a few).
const COMMON_COUNTRIES = dict({ US: "United States", GB: "United Kingdom", JP: "Japan", DE: "Germany", FR: "France", IN: "India", AU: "Australia", CA: "Canada", CN: "China" });
function countryNameLazy(cc) {
  return COMMON_COUNTRIES[cc] || countryName(cc);
}
function loadFavs() {
  const text = readFile(favsPath());
  if (text === null) return DEFAULT_FAVS.map(sanitizeFav);
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : Array.isArray(j.cities) ? j.cities : null;
    if (!list) throw new Error("bad");
    return list.slice(0, 100).map(sanitizeFav).filter(Boolean);
  } catch (e) {
    NOTICES.push(info("Couldn’t read your saved cities", "The file is damaged; adding a city starts a new list", "warn"));
    return DEFAULT_FAVS.map(sanitizeFav);
  }
}
function saveFavs(list) {
  mkdirs(dataDir());
  const clean = list.map((f) => {
    const o = { name: f.name, cc: f.cc || "" };
    if (f.zone) o.zone = f.zone;
    else {
      o.fixed = f.fixed;
      o.fixedAbbr = f.fixedAbbr;
    }
    if (typeof f.lat === "number") Object.assign(o, { lat: f.lat, lon: f.lon });
    if (f.admin) o.admin = f.admin;
    if (f.label) o.label = f.label;
    return o;
  });
  return writeFile(favsPath(), JSON.stringify({ version: 1, cities: clean }, null, 1));
}
const FAVS = loadFavs();

function placeId(p) {
  return `${p.zone || `fixed${p.fixed}`}|${fold(p.name)}`;
}
function isFav(p) {
  const id = placeId(p);
  return FAVS.some((f) => placeId(f) === id);
}
function favPayload(p, op, label) {
  const o = { op, name: p.name, cc: p.cc || "" };
  if (p.zone) o.zone = p.zone;
  else {
    o.fixed = p.fixed;
    o.fixedAbbr = p.fixedAbbr || fmtUtc(p.fixed);
  }
  if (typeof p.lat === "number" && isFinite(p.lat)) Object.assign(o, { lat: p.lat, lon: p.lon });
  if (p.admin) o.admin = p.admin;
  if (label) o.label = label;
  return `wcfav:${JSON.stringify(o)}`;
}
function sortPlaces(list, ms) {
  if (SORT_ADDED) return list.slice();
  return list.map((p, i) => [p, offsetAt(p, ms), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
}
function displayName(p) {
  return p.label || p.name;
}

// ---------- rows ----------

// "10:05 PM JST, Tue 29 Sep" or "10:05 PM in Kathmandu (UTC+5:45), Tue 29 Sep"
function copyText(p, ms) {
  const w = wall(p, ms), a = abbrAt(p, ms);
  const where = a ? a : `in ${displayName(p)} (${fmtUtc(w.off)})`;
  return `${fmtTime(w)} ${where}, ${fmtDay(w)}`;
}
function copyAll(list, ms) {
  return list.map((p) => `${displayName(p)}: ${copyText(p, ms)}`).join("\n");
}
function dstNote(p, ms) {
  const t = nextTransition(p, ms);
  if (t === null || t - ms > 14 * DAY) return "";
  const before = offsetAt(p, t - 1000), after = offsetAt(p, t + 1000);
  if (before === after) return "";
  const dir = after > before ? "forward" : "back";
  return `clocks go ${dir} ${fmtSpan((after - before) * 1000)} ${fmtDay(wall(p, t + 1000))}`;
}
// "today", "tomorrow" or "yesterday" in your calendar (the Mac's time zone), or "".
function relDay(w) {
  const n = w.day - wall(LOCAL, NOW).day;
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : "";
}

// A place's time as an Alfred row. `ref`: the place that offsets and "tomorrow" are relative to.
function timeRow(p, ms, ref, o) {
  o = o || {};
  const w = wall(p, ms), rw = wall(ref, ms);
  const name = displayName(p) + (p.label ? ` (${p.name})` : "") + (p.here && !o.noHere ? " (here)" : "");
  const dayTag = w.day !== rw.day ? ` ${DOW[w.dow]}` : "";
  const light = daylight(p, ms);
  const rd = relDay(w);
  const parts = [fmtDay(w) + (rd && (rd !== "today" || o.source) ? ` (${rd})` : "")];
  if (o.source) parts.push(o.source);
  else if (!(p.here && ref === LOCAL)) parts.push(`${fmtDiff(w.off - rw.off)}${ref === LOCAL ? "" : ` from ${displayName(ref)}`}`);
  parts.push(zoneLabel(p, ms));
  if (o.then && p.fixed == null && offsetAt(p, NOW) !== w.off) {
    parts.push(`${abbrAt(p, ms) || fmtUtc(w.off)} then, ${abbrAt(p, NOW) || fmtUtc(offsetAt(p, NOW))} now`);
  }
  const dst = dstNote(p, ms);
  if (dst) parts.push(dst);
  if (o.extra) parts.push(o.extra);
  const text = copyText(p, ms);
  const fav = isFav(p);
  const it = {
    title: `${p.noFlag ? "" : flagOf(p.cc)}${name}  ${fmtTime(w)}${dayTag}`,
    subtitle: parts.join(" · "),
    arg: text,
    icon: { path: `icons/${light}.png` },
    text: { copy: text, largetype: `${displayName(p)}\n${fmtTime(w)}\n${fmtDay(w)}` },
    mods: {
      cmd: { arg: text, subtitle: `Paste “${text}”` },
      alt: { arg: o.all || text, subtitle: "Copy all cities" },
      ctrl: { arg: iso(p, ms), subtitle: `Copy as ISO 8601: ${iso(p, ms)}` },
    },
  };
  if (!p.here || p.kind === "fav") {
    it.mods.shift = fav
      ? { arg: favPayload(p, "remove"), subtitle: `Remove ${displayName(p)} from the world clock` }
      : { arg: favPayload(p, "add"), subtitle: `Add ${displayName(p)} to the world clock` };
  } else it.mods.shift = { arg: text, valid: false, subtitle: "This is your Mac’s time zone" };
  if (o.uid) it.uid = o.uid;
  return it;
}

// ---------- the parser ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = dict({ sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 });
const SEPARATORS = new Set(["in", "to", "into", "->", "for"]);
const UNITS = dict({ h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR, m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN, d: DAY, day: DAY, days: DAY, w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY });

function isDurationStart(tokens, i) {
  const a = tokens[i + 1] || "", b = tokens[i + 2] || "";
  return /^\d+(\.\d+)?$/.test(a) ? !!UNITS[b.toLowerCase()] : /^\d+(\.\d+)?[a-z]+$/i.test(a) && !!UNITS[a.replace(/^[\d.]+/, "").toLowerCase()];
}

// Pull the date and time out of a phrase. Returns what was found and the words left over (the place).
function extractTime(input) {
  const t = { rest: "", errors: [], explicit: false };
  let s = ` ${input} `;
  const take = (re, fn) => {
    s = s.replace(re, (...m) => {
      const r = fn(...m);
      return r === false ? m[0] : " ";
    });
  };
  // ISO 8601: 2026-10-05, 2026-10-05T14:00, 2026-10-05 14:00:00Z, …+05:30
  take(/\s(\d{4})-(\d{1,2})-(\d{1,2})(?:[tT\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+\-]\d{2}:?\d{2})?)?(?=\s)/, (m, y, mo, d, h, mi, sec, z) => {
    t.date = { y: +y, mo: +mo, d: +d };
    if (h != null) t.time = { h: +h, mi: +mi };
    if (z) t.isoOffset = z.toUpperCase() === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 3600 + +z.slice(-2) * 60);
  });
  // in 2 hours, +90m, -1d, 3 days ago
  take(/\s(?:(in)\s+)?([+\-])?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d|weeks?|wks?|w)(\s+ago)?(?=\s)/i, (m, inw, sign, n, unit, ago) => {
    if (!inw && !sign && !ago) return false;
    t.delta = (t.delta || 0) + (sign === "-" || ago ? -1 : 1) * parseFloat(n) * UNITS[unit.toLowerCase()];
  });
  take(/\s(now|right now)(?=\s)/i, () => {
    t.now = true;
  });
  take(/\s(today|tonight|tomorrow|tmrw|tmr|tomorow|yesterday)(?=\s)/i, (m, w) => {
    const k = w.toLowerCase();
    t.rel = k === "yesterday" ? -1 : k === "today" || k === "tonight" ? 0 : 1;
    if (k === "tonight") t.tonight = true;
  });
  // 5 Oct, 5th October 2026, Oct 5, October 5th, 2026
  take(new RegExp(`\\s(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?(?=\\s)`, "i"), (m, d, mon, y) => {
    t.date = { mo: MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1, d: +d, y: y ? +y : null };
  });
  take(new RegExp(`\\s${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=[\\s,])`, "i"), (m, mon, d, y) => {
    t.date = { mo: MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1, d: +d, y: y ? +y : null };
  });
  take(/\s(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)(?=\s)/i, (m, next, w) => {
    const k = w.toLowerCase();
    if (!(k in WEEKDAYS)) return false;
    t.weekday = { dow: WEEKDAYS[k], next: !!next };
  });
  // 10/5, 10/5/2026 (in the order of the Mac's region), 5.10. or 5.10.2026 (always day first)
  take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?=\s)/, (m, a, b, y) => {
    const [mo, d] = MDY ? [+a, +b] : [+b, +a];
    t.date = { mo, d, y: y ? (y.length === 2 ? 2000 + +y : +y) : null };
  });
  take(/\s(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=\s)/, (m, d, mo, y) => {
    t.date = { mo: +mo, d: +d, y: y ? +y : null };
  });
  take(/\s(noon|midday|midnight)(?=\s)/i, (m, w) => {
    t.time = { h: w.toLowerCase() === "midnight" ? 0 : 12, mi: 0 };
  });
  // 3pm, 3 pm, 3:30pm, 3.30 p.m., 15:30, 9h30, 9h
  const ampm = (h, ap) => {
    if (!ap) return h;
    if (h < 1 || h > 12) return -1;
    const pm = ap[0].toLowerCase() === "p";
    return (h % 12) + (pm ? 12 : 0);
  };
  take(/\s(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?|a|p)?(?=\s)/i, (m, h, mi, ap) => {
    if (t.time) return false;
    const hh = ampm(+h, ap);
    if (hh < 0 || hh > 23 || +mi > 59) t.errors.push(m.trim());
    else t.time = { h: hh, mi: +mi };
  });
  take(/\s(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?=\s)|\s(\d{1,2})(a|p)(?=\s)/i, (m, h1, ap1, h2, ap2) => {
    if (t.time) return false;
    const hh = ampm(+(h1 || h2), ap1 || ap2);
    if (hh < 0) t.errors.push(m.trim());
    else t.time = { h: hh, mi: 0 };
  });
  take(/\s(\d{1,2})h(?=\s)/i, (m, h) => {
    if (t.time || +h > 23) return false;
    t.time = { h: +h, mi: 0 };
  });
  // 1430 or 930 (no colon), then a bare hour ("9 London")
  take(/\s(\d{3,4})(?=\s)/, (m, n) => {
    if (t.time) return false;
    const h = Math.floor(+n / 100), mi = +n % 100;
    if (h > 23 || mi > 59) {
      t.errors.push(n);
      return;
    }
    t.time = { h, mi };
  });
  take(/\s(\d{1,2})(?=\s)/, (m, n) => {
    if (t.time || +n > 23) return false;
    t.time = { h: +n, mi: 0 };
  });
  if (t.tonight && !t.time) t.time = { h: 20, mi: 0 };
  t.explicit = !!(t.time || t.date || t.weekday || t.rel);
  t.any = t.explicit || t.now || t.delta != null;
  t.rest = s.replace(/\s(at|on|from|@)(?=\s)/gi, " ").replace(/\s+/g, " ").trim();
  return t;
}

// Split "3pm PST in Tokyo" into its left side and target phrase.
function splitTargets(q) {
  const tokens = q.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 2; i >= 0; i--) {
    const k = tokens[i].toLowerCase();
    if (!SEPARATORS.has(k)) continue;
    if (k === "in" && isDurationStart(tokens, i)) continue;
    return { left: tokens.slice(0, i).join(" "), right: tokens.slice(i + 1).join(" ") };
  }
  const last = (tokens[tokens.length - 1] || "").toLowerCase();
  if (tokens.length > 1 && SEPARATORS.has(last)) return { left: tokens.slice(0, -1).join(" "), right: "" };
  return { left: tokens.join(" "), right: null };
}

// When a phrase names a time: the instant, with notes about DST gaps and doubled hours.
function computeInstant(t, src) {
  const notes = [];
  if (t.isoOffset != null && t.date && t.time) {
    const ms = Date.UTC(t.date.y, t.date.mo - 1, t.date.d, t.time.h, t.time.mi) - t.isoOffset * 1000;
    return { ms: ms + (t.delta || 0), notes, fixedSource: t.isoOffset };
  }
  if (!t.explicit) return { ms: NOW + (t.delta || 0), notes, live: true };
  const base = wall(src, NOW);
  let day = { y: base.y, mo: base.mo, d: base.d, dow: base.dow };
  if (t.date) {
    const y = t.date.y || base.y;
    if (t.date.mo < 1 || t.date.mo > 12 || t.date.d < 1 || t.date.d > 31) return { error: "date" };
    let chk = new Date(Date.UTC(y, t.date.mo - 1, t.date.d));
    if (chk.getUTCMonth() !== t.date.mo - 1) return { error: "date" };
    // "5 Mar" without a year means the next 5 March
    if (!t.date.y && chk.getTime() < Date.UTC(base.y, base.mo - 1, base.d)) chk = new Date(Date.UTC(y + 1, t.date.mo - 1, t.date.d));
    if (chk.getUTCMonth() !== t.date.mo - 1) return { error: "date" };
    day = { y: chk.getUTCFullYear(), mo: t.date.mo, d: t.date.d, dow: chk.getUTCDay() };
  } else if (t.weekday) {
    let n = (t.weekday.dow - base.dow + 7) % 7;
    if (t.weekday.next && n === 0) n = 7;
    day = addDays(base.y, base.mo, base.d, n);
  }
  if (t.rel) day = addDays(day.y, day.mo, day.d, t.rel);
  const time = t.time || { h: base.h, mi: base.mi };
  const r = wallToInstant(src, day.y, day.mo, day.d, time.h, time.mi);
  const wanted = fmtTime({ h: time.h, mi: time.mi });
  if (r.gap) {
    const shown = wall(src, r.ms);
    notes.push(info(`${wanted} doesn’t exist in ${displayName(src)} on ${fmtDay({ ...day })}`,
      `Clocks go forward then; showing ${fmtTime(shown)} ${abbrAt(src, r.ms) || ""}`.trim(), "warn"));
  } else if (r.second != null) {
    notes.push(info(`${wanted} happens twice in ${displayName(src)} on ${fmtDay({ ...day })}`,
      `Clocks go back; showing the first (${zoneLabel(src, r.ms)}). The second is ${fmtSpan(r.second - r.ms)} later (${zoneLabel(src, r.second)})`, "warn"));
  }
  return { ms: r.ms + (t.delta || 0), notes };
}

// Rows offering the other meanings of an ambiguous place ("IST", "Portland", "USA").
function altRowsFor(p, query, token) {
  if (!p.alts || !p.alts.length) return [];
  const rows = [];
  const what = p.abbr ? p.abbr : p.viaCountry ? p.viaCountry : p.name;
  const first = p.abbr ? `${p.name.replace(/ time$/, "")}` : p.full;
  rows.push(info(`“${what}” is ambiguous: using ${first}`, "Choose another meaning below", "choice"));
  for (const a of p.alts) {
    const repl = a.zone ? (a.kind === "city" ? `${a.name} ${a.admin || countryName(a.cc)}` : a.zone) : fmtUtc(a.fixed).replace("−", "-");
    const auto = replaceWord(query, token, repl);
    rows.push(info(`Use ${a.abbr ? a.name.replace(/ time$/, "") + " time" : a.full}`, `${zoneLabel(a, NOW)} · ↩ to switch`, "choice", { autocomplete: auto }));
  }
  return rows;
}
function replaceWord(query, token, repl) {
  if (!token) return query;
  const re = new RegExp(`(^|[\\s,])${esc(token)}(?=$|[\\s,])`, "i");
  return re.test(query) ? query.replace(re, (m, pre) => pre + repl) : query;
}

// A typed abbreviation whose fixed offset differs from its zone on that date: "EST" in July.
function strictNote(p, ms, query) {
  if (p.kind !== "abbr" || p.strict == null || p.fixed != null) return null;
  const actual = offsetAt(p, ms);
  if (actual === p.strict) return null;
  const now = abbrAt(p, ms) || fmtUtc(actual);
  return info(`${p.abbr} is ${fmtUtc(p.strict)}, but ${p.name} is on ${now} (${fmtUtc(actual)}) then`,
    `Showing ${p.name}; ↩ to use ${fmtUtc(p.strict)} exactly`, "warn",
    { autocomplete: replaceWord(query, p.abbr, fmtUtc(p.strict).replace("−", "-")) });
}

// ---------- world clock and converter ----------

function worldClock() {
  RERUN = liveRerun();
  const list = sortPlaces(FAVS.filter((f) => placeId(f) !== placeId(LOCAL)), NOW);
  const all = copyAll([LOCAL].concat(list), NOW);
  const rows = [timeRow(LOCAL, NOW, LOCAL, { all })];
  for (const p of list) rows.push(timeRow(p, NOW, LOCAL, { all }));
  if (!FAVS.length) rows.push(info("Add a city", "Type a city, country or time zone after the keyword, then ⇧↩ to add it", "add", { valid: false, autocomplete: "add " }));
  return rows;
}

// Seconds until the next minute (Alfred allows 0.1–5).
function liveRerun() {
  if (env("WC_NOW", "")) return 1;
  const s = (MIN - (NOW % MIN)) / 1000 + 0.05;
  return Math.max(0.1, Math.min(5, Math.round(s * 10) / 10));
}

function searchRows(phrase, mode, label) {
  const key = fold(phrase);
  const seen = new Set(), places = [];
  const push = (p) => {
    if (!p) return;
    const id = placeId(p);
    if (!seen.has(id)) {
      seen.add(id);
      places.push(p);
    }
  };
  const exact = resolvePhrase(phrase);
  if (exact) {
    push(exact);
    for (const a of exact.alts || []) push(a);
    // "IST": its meanings are the answer, not Istanbul and Istres
    if (exact.abbr || exact.kind === "offset") return rowsFor(places, mode, label);
  }
  for (const f of FAVS) if (key && (fold(displayName(f)).startsWith(key) || fold(f.name).startsWith(key))) push(f);
  if (key.length >= 1) {
    const name = PLACE_ALIAS[key] || key;
    for (const r of exactRows(name, 5)) push(rowPlace(r));
    for (const r of prefixRows(name, 12)) push(rowPlace(r));
    for (const r of altRows(name, 3)) push(rowPlace(r));
    const cc = countryByName(key);
    if (cc) for (const p of countryCities(cc, 6)) push(p);
  }
  return rowsFor(places.slice(0, 15), mode, label);
}
function rowsFor(places, mode, label) {
  const all = copyAll(places, NOW);
  return places.map((p) => searchRow(p, mode, label, all));
}
function searchRow(p, mode, label, all) {
  {
    const row = timeRow(p, NOW, LOCAL, { all, extra: p.full && p.full !== p.name ? p.full : "" });
    const fav = isFav(p);
    if (mode === "add") {
      if (fav && label !== null && label !== undefined) {
        row.arg = favPayload(p, "rename", label);
        row.subtitle = `↩ Rename to “${label}” · ${row.subtitle}`;
        row.icon = { path: "icons/add.png" };
      } else {
        row.arg = fav ? favPayload(p, "remove") : favPayload(p, "add", label);
        row.subtitle = `${fav ? "↩ Remove from" : "↩ Add to"} the world clock${label && !fav ? ` as “${label}”` : ""} · ${row.subtitle}`;
        row.icon = { path: `icons/${fav ? "remove" : "add"}.png` };
      }
      row.title = `${fav ? "★ " : ""}${row.title}`;
      delete row.mods.shift;
    } else if (fav) row.title = `★ ${row.title}`;
    return row;
  }
}

function addMode(q) {
  let phrase = q, label = null;
  const m = /^(.*?)\s+(?:as|=)\s+(.+)$/i.exec(q);
  if (m) {
    phrase = m[1];
    label = m[2].trim().slice(0, 40);
  }
  if (!phrase.trim()) {
    const rows = [info("Add a city to the world clock", "Type a city, country, time zone (CET, America/Chicago) or UTC offset; add “as Name” for a label", "add")];
    for (const f of sortPlaces(FAVS, NOW)) {
      const r = timeRow(f, NOW, LOCAL, {});
      r.arg = favPayload(f, "remove");
      r.subtitle = `↩ Remove from the world clock · ${r.subtitle}`;
      r.icon = { path: "icons/remove.png" };
      delete r.mods.shift;
      rows.push(r);
    }
    return rows;
  }
  const rows = searchRows(phrase, "add", label);
  return rows.length ? rows : [notFound(phrase)];
}

function notFound(phrase) {
  return info(`Couldn’t find “${phrase}”`, "Try a city, a country, a zone like CET or America/Chicago, or UTC+5:30", "error");
}

function clockFilter(query) {
  let q = String(query || "").replace(/[→⇒]|->|=>/g, " to ").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  if (!q) return worldClock();
  const am = /^(add|remove|rm|edit|manage)(?:\s+(.*))?$/i.exec(q);
  if (am) return addMode(am[2] || "");
  // "3pm PST i": a separator being typed
  q = q.replace(/\s(i|t|int)$/i, "");
  let { left, right } = splitTargets(q);
  const t = extractTime(left);
  // "London to NYC tomorrow 9am": a date or time after the targets counts too
  if (right) {
    const tr = extractTime(right);
    if (tr.any || tr.errors.length) {
      for (const k of ["date", "time", "weekday", "rel", "delta", "now", "isoOffset", "tonight"]) if (t[k] == null && tr[k] != null) t[k] = tr[k];
      t.errors.push(...tr.errors);
      t.explicit = !!(t.time || t.date || t.weekday || t.rel);
      t.any = t.explicit || t.now || t.delta != null;
      right = tr.rest;
    }
  }
  if (t.errors.length) return [info(`Couldn’t read the time “${t.errors[0]}”`, "Try 3pm, 15:30, 1530, noon or tomorrow 9:00", "error")];
  // Just a place: its time now, and similar places to add
  if (!t.any && (right === null || right === "")) {
    RERUN = liveRerun();
    const phrase = t.rest || left;
    const p = resolvePhrase(phrase);
    if (!p) {
      // "London NYC": several places, each now
      const seg = segmentPlaces(phrase);
      if (seg.places.length >= 2 && !seg.unknown.length) {
        const all = copyAll(seg.places, NOW);
        return seg.places.map((x) => timeRow(x, NOW, LOCAL, { all }));
      }
    }
    const rows = searchRows(phrase, "search");
    if (p && p.alts && p.alts.length && p.abbr) rows.splice(0, 0, info(`“${p.abbr}” has ${p.alts.length + 1} meanings`, "All of them are listed below", "choice"));
    return rows.length ? rows : [notFound(t.rest || left)];
  }
  let src = LOCAL, srcToken = "", impliedTargets = null;
  if (t.rest) {
    src = resolvePhrase(t.rest);
    srcToken = t.rest;
    if (!src && right === null) {
      // "5pm PT Shanghai Zurich": the first place is the source, the others the targets
      const seg = segmentPlaces(t.rest);
      if (seg.places.length >= 2 && !seg.unknown.length) {
        src = seg.places[0];
        srcToken = src.token;
        impliedTargets = seg.places.slice(1);
      }
    }
    if (!src) src = resolveLoose(t.rest);
    if (!src && fold(t.rest).length < 3) return [info("Keep typing a place", "A city, a country, a zone like PST or Europe/Paris, or UTC+5:30", "info", { valid: false })];
    if (!src) {
      // "Tokyo" alone with a separator typo, e.g. "Rio de Janeiro" read as a time: try the whole query
      const whole = right ? null : resolvePhrase(q);
      if (whole) return searchRows(q, "search");
      return [notFound(t.rest)];
    }
  }
  const r = computeInstant(t, src);
  if (r.error) return [info("Couldn’t read the date", "Try tomorrow, Friday, 5 Oct, Oct 5 or 2026-10-05", "error")];
  if (r.fixedSource != null && !t.rest) src = offsetPlace(fmtUtc(r.fixedSource).replace("−", "-")) || Object.assign({}, LOCAL);
  if (r.fixedSource === 0 && !t.rest) src = abbrPlaces("UTC")[0];
  const ms = r.ms;
  if (r.live) RERUN = liveRerun();
  let targets, unknown = [];
  if (impliedTargets) targets = impliedTargets;
  else if (right) {
    const seg = segmentPlaces(right);
    targets = seg.places;
    unknown = seg.unknown;
    if (!targets.length) {
      // "Rio de Janeiro", "Stoke on Trent": maybe the separator was part of a name
      const whole = !t.any ? resolvePhrase(q) : null;
      if (whole) return searchRows(q, "search");
      if (fold(right).length >= 3) return [notFound(right)];
      // still typing the place after "in": show the saved cities meanwhile
      unknown = [];
      targets = sortPlaces(FAVS, ms);
      if (placeId(src) !== placeId(LOCAL)) targets = [LOCAL].concat(targets);
    }
  } else {
    targets = sortPlaces(FAVS, ms);
    if (src !== LOCAL && placeId(src) !== placeId(LOCAL)) targets = [LOCAL].concat(targets);
  }
  const seenIds = new Set([placeId(src)]);
  targets = targets.filter((p) => {
    const id = placeId(p);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  const all = copyAll([src].concat(targets), ms);
  const rows = [];
  const srcNote = relNow(ms);
  rows.push(timeRow(src, ms, src, { all, source: srcNote, then: true }));
  const sn = strictNote(src, ms, q);
  if (sn) rows.push(sn);
  rows.push(...r.notes);
  rows.push(...altRowsFor(src, q, srcToken));
  for (const u of unknown) rows.push(notFound(u));
  for (const p of targets) {
    rows.push(timeRow(p, ms, src, { all, then: t.explicit }));
    const n = right || impliedTargets ? strictNote(p, ms, q) : null;
    if (n) rows.push(n);
    if ((right || impliedTargets) && p.alts && p.alts.length) rows.push(...altRowsFor(p, q, p.token || p.abbr || null));
  }
  if (!targets.length && !right) rows.push(info("No cities in your world clock", `Type “${kwClock()} add” to add some`, "add", { autocomplete: "add " }));
  return rows;
}

// ---------- meeting planner ----------

// Weekends that aren't Saturday and Sunday.
const WEEKEND = dict({
  SA: [5, 6], KW: [5, 6], QA: [5, 6], BH: [5, 6], OM: [5, 6], EG: [5, 6], IQ: [5, 6], JO: [5, 6], LY: [5, 6], SY: [5, 6],
  YE: [5, 6], DZ: [5, 6], SD: [5, 6], IL: [5, 6], BD: [5, 6], MV: [5, 6], IR: [5], AF: [5], NP: [6], BN: [5, 0],
});
function statusAt(p, ms) {
  const w = wall(p, ms);
  const h = w.h + w.mi / 60;
  const weekend = (WEEKEND[p.cc || zoneCountry(p.zone || "")] || [6, 0]).includes(w.dow);
  if (!weekend && h >= WORK_START && h < WORK_END) return "work";
  if (h >= 7 && h < 22) return weekend ? "weekend" : "awake";
  return "asleep";
}
const MARK = dict({ work: "●", awake: "◐", weekend: "◐", asleep: "○" });

function whenFilter(query) {
  const q = String(query || "").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  const t = extractTime(q);
  let places = [], unknown = [];
  if (t.rest) {
    const seg = segmentPlaces(t.rest);
    places = seg.places;
    unknown = seg.unknown;
  } else places = sortPlaces(FAVS, NOW);
  if (!places.some((p) => (p.zone && p.zone === LOCAL.zone) || placeId(p) === placeId(LOCAL))) places = [LOCAL].concat(places);
  const rows = unknown.map(notFound);
  if (places.length < 2) {
    rows.push(info("Plan a meeting", "Type the cities, like London NYC Tokyo, and optionally a day: tomorrow, Friday, 5 Oct", "info"));
    return rows;
  }
  // Start: the current hour, or midnight of the day asked for (in your time zone)
  let start, count = 24;
  const lw = wall(LOCAL, NOW);
  if (t.date || t.weekday || t.rel) {
    const r = computeInstant(Object.assign({}, t, { time: { h: 0, mi: 0 } }), LOCAL);
    if (r.error) return [info("Couldn’t read the date", "Try tomorrow, Friday, 5 Oct or 2026-10-05", "error")];
    start = r.ms;
  } else if (t.time) {
    const r = computeInstant(t, LOCAL);
    start = r.ms;
  } else start = NOW - (lw.mi * MIN) - ((NOW % MIN));
  const slots = [];
  for (let i = 0; i < count; i++) {
    const ms = start + i * HOUR;
    const st = places.map((p) => statusAt(p, ms));
    slots.push({ ms, st, work: st.filter((s) => s === "work").length, awake: st.filter((s) => s !== "asleep").length });
  }
  // The best time: the most people at work, then the most awake; the soonest run of that same pattern
  const score = (x) => x.work * 100 + x.awake;
  const bestScore = Math.max(...slots.map(score));
  const bestN = Math.max(...slots.map((x) => x.work));
  let bestRun = null;
  for (let i = 0; i < slots.length; i++) {
    if (score(slots[i]) !== bestScore) continue;
    const sig = slots[i].st.join();
    let j = i;
    while (j + 1 < slots.length && slots[j + 1].st.join() === sig) j++;
    // the first such run: the soonest time that works
    bestRun = [i, j];
    break;
  }
  const names = places.map((p) => shortName(p));
  const slotText = (ms) => {
    const w0 = wall(places[0], ms);
    return `${fmtDay(w0)}: ` + places.map((p) => {
      const w = wall(p, ms);
      return `${fmtTime(w)} ${displayName(p)}${w.day !== w0.day ? ` (${DOW[w.dow]})` : ""}`;
    }).join(" / ");
  };
  if (bestN > 0 && bestRun) {
    const a = slots[bestRun[0]].ms, b = slots[bestRun[1]].ms + HOUR;
    const aw = wall(LOCAL, a), bw = wall(LOCAL, b);
    const everyone = bestN === places.length;
    rows.push({
      title: `${everyone ? "Best" : "Closest"}: ${fmtTime(aw)}–${fmtTime(bw)} ${fmtDay(aw)} your time`,
      subtitle: everyone ? `Working hours for everyone (${WORK_START}:00–${WORK_END}:00 on weekdays)` : `${bestN} of ${places.length} in working hours; no hour suits everyone`,
      arg: slotText(a), icon: { path: `icons/${everyone ? "best" : "partial"}.png` },
      mods: { cmd: { arg: slotText(a), subtitle: "Paste this time for everyone" }, alt: { arg: slots.map((s) => slotText(s.ms)).join("\n"), subtitle: "Copy the whole grid" }, ctrl: { arg: iso(LOCAL, a), subtitle: `Copy as ISO 8601: ${iso(LOCAL, a)}` } },
      text: { copy: slotText(a), largetype: slotText(a) },
    });
  } else rows.push(info("No hour has anyone in working hours", "Try another day, like tomorrow or Monday", "partial"));
  const grid = slots.map((s) => slotText(s.ms)).join("\n");
  // Every row can copy the grid, unless that would make Alfred's JSON large (many cities): then the top row does
  const gridMod = grid.length * slots.length < 40000
    ? { arg: grid, subtitle: "Copy the whole grid" }
    : { arg: "", valid: false, subtitle: "Copy the whole grid from the first row" };
  let lastDay = null;
  for (const [si, s] of slots.entries()) {
    const cells = places.map((p, k) => `${MARK[s.st[k]]} ${fmtShort(wall(p, s.ms))} ${names[k]}`);
    const lw2 = wall(LOCAL, s.ms);
    const inBest = bestN > 0 && bestRun && si >= bestRun[0] && si <= bestRun[1];
    const icon = inBest ? "best" : s.work === places.length ? "work" : s.awake === places.length ? "partial" : "off";
    const dayChange = lastDay !== null && lw2.day !== lastDay ? " · new day" : "";
    lastDay = lw2.day;
    const text = slotText(s.ms);
    rows.push({
      title: cells.join("   "),
      subtitle: `${fmtDay(lw2)} ${fmtTime(lw2)} your time · ${s.work} of ${places.length} in working hours${dayChange}`,
      arg: text, icon: { path: `icons/${icon}.png` },
      text: { copy: text, largetype: text.replace(/ \/ /g, "\n") },
      mods: {
        cmd: { arg: text, subtitle: "Paste this time for everyone" },
        alt: gridMod,
        ctrl: { arg: iso(LOCAL, s.ms), subtitle: `Copy as ISO 8601: ${iso(LOCAL, s.ms)}` },
      },
    });
  }
  return rows;
}

// ---------- actions ----------

function act(arg) {
  if (!String(arg || "").startsWith("wcfav:")) return undefined;
  let o;
  try {
    o = JSON.parse(arg.slice(6));
  } catch (e) {
    return undefined;
  }
  const p = sanitizeFav(o);
  if (!p || !["add", "remove", "rename"].includes(o.op)) return undefined;
  const list = FAVS.slice();
  const id = placeId(p);
  const i = list.findIndex((f) => placeId(f) === id);
  if (o.op === "add" && i < 0) list.push(p);
  else if (o.op === "add" && p.label) list[i].label = p.label;
  else if (o.op === "remove" && i >= 0) list.splice(i, 1);
  else if (o.op === "rename" && i >= 0) {
    if (p.label) list[i].label = p.label;
    else delete list[i].label;
  }
  saveFavs(list);
  if (!TEST_MODE) {
    try {
      Application(ALFRED).search(`${kwClock()} `);
    } catch (e) {}
  }
  return undefined;
}

function run(argv) {
  const cmd = argv[0] || "clock", q = argv.slice(1).join(" ");
  if (cmd === "act") return act(q);
  try {
    if (cmd === "when") return output(whenFilter(q));
    return output(clockFilter(q));
  } catch (e) {
    return output([info("Couldn’t show the time", String(e && e.message ? e.message : e), "error")]);
  }
}
