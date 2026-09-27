# World Clock — Plan

**Bundle ID:** `io.github.x-o-r-r-o.worldclock` · **Keywords:** `clock` (world clock, converter, `clock add`), `when` (meeting planner)

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-28):

| Raycast extension | Downloads |
|---|---|
| Timezone Converter (joao.mainka) | ~22,000 |
| World Clock (koinzhang) | ~9,000 |
| **Total** | **~31,000** |

What their users ask for (raycast/extensions issues): UTC and Anywhere on Earth (AoE) as zones, typing a time to convert instead of only "now", searching by country or state (Utah, "Mumbai isn’t there"), custom labels, sort order, the weekday next to the time, abbreviations like PST shown, 24-hour and dd/mm settings, correct half-hour zones (India; two bugs), correct times across DST changes (menu-bar bug), and no network failures (World Clock calls timeapi.io and breaks offline).

**Alfred today:**
- Gallery “World Clock” (fedecalendino): Python with 3rd-party libraries (`now`, `meet`, `offset`); zones typed by hand as IANA names in the configuration; issues ask for AoE, HHMM without a colon, custom formats, UTC in the copied text.
- “Timezones for Alfred” (forum, Mar 2026): Python (not shipped with macOS since 12.3), GeoLite2 cities, `tz` / `tza`, Dropbox download, no ambiguity handling or planner.
- “Quick Timezone Changer” (forum, 2025): changes the Mac’s time zone (a different job; out of scope, it needs admin rights).

## Features (v1.0)
- [x] `clock`: here + saved cities with local time, weekday (in the title when the day differs), date, today/tomorrow/yesterday, offset from you, abbreviation and UTC offset, next DST change within 14 days, and a day / dawn / dusk / night icon from the real sun position (NOAA formulas with the city’s coordinates)
- [x] Live: reruns at the next minute boundary (max 5 s) with stable uids
- [x] Look up any of 34,184 places (GeoNames cities15000 + one place per IANA zone without a city), alternate names (Bombay, München, Kiev), aliases (NYC, SF, LA, DC), countries (all zones of the USA), states (Utah), “City, State/Country” and “City Qualifier” (Paris Texas), IANA names, abbreviations (60+, with AoE, UTC, Z), UTC/GMT offsets
- [x] `clock add` manage screen: ↩ add or remove, `as Label` for a custom name, ⇧↩ from any row; saved to `cities.json` in the workflow’s data folder (atomic write, validated on read)
- [x] Converter: `3pm PST in Tokyo`, `tomorrow 9:00 London to NYC`, `noon here in Berlin`, `now in Sydney`, `14:30 CET` (→ all cities), `5pm PT Shanghai Zurich` (no separator), `London to NYC tomorrow 9am` (date after the cities), ISO 8601 with offsets, `in 2 hours`, `+90m`, `3 days ago`; times `3pm`, `3 p.m.`, `15:30`, `1530`, `930`, `9h30`, `noon`, `midnight`; dates `tomorrow`, weekdays, `next monday`, `5 Oct`, `Oct 5th`, `10/5` (region order), `5.10.`, ISO; a date without a year that has passed means next year
- [x] Ambiguity: CST / IST / BST / AST / GST / SST / PST / CDT choices ordered by the Mac’s region (or the local zone’s country), each offered as an autocomplete row; ambiguous city names (Portland, Chatham) too
- [x] DST: a skipped time (“2:30 AM doesn’t exist…”, NSCalendar moves it forward), a doubled time (first shown, second named), a typed standard-time abbreviation in summer (“EST is UTC−5, but … is on EDT”, ↩ switches to the exact offset), “EST then, EDT now” when a converted date is in the other season
- [x] `when`: 24 hourly rows from the current hour (or a whole day: `when London NYC Tokyo tomorrow`), ● working hours / ◐ awake or weekend / ○ night per city, soonest best slot on top (everyone at work, else most at work and most awake), local weekends (Fri–Sat in the Gulf and Israel, Fri in Iran…), configurable working hours; uses the world clock without cities
- [x] Actions: ↩ copy (`10:05 PM JST, Tue 29 Sep`), ⌘↩ paste, ⌥↩ copy all cities / the whole grid, ⌃↩ ISO 8601 with offset, ⇧↩ add/remove, ⌘L Large Type
- [x] Universal Action “Convert Time with World Clock” for selected text
- [x] 12/24 h “Same as macOS” (short time style, h/K check, `j` template fallback — the alfred-f1 rule), date order from the region, both overridable
- [x] All zone maths through NSTimeZone (`secondsFromGMTForDate`, `isDaylightSavingTimeForDate`, `nextDaylightSavingTimeTransitionAfterDate`) and NSCalendar (`dateFromComponents`); newer zone names fall back to their old names on older macOS (Europe/Kyiv → Europe/Kiev…)

## Tech
- JXA with the ObjC bridge (Foundation only). No network, no background processes, no secrets.
- `src/data/cities.tsv` (1.8 MB, most populous first) is searched with `indexOf` / one regex per lookup; the world clock itself never loads it. `meta.json` (89 KB): zones, countries, states, zone.tab.
- `tools/make_cities.py` regenerates the data from GeoNames (CC BY 4.0, attribution in README, About and `src/data/ATTRIBUTION.txt`).
- Every keystroke runs in 60–120 ms (measured on Apple Silicon).

## Known limitations
- Abbreviation display comes from a table (macOS shows “GMT+2” for Berlin); zones outside it show “UTC+x”.
- Country lookups pick the most populous city; multi-zone countries list the others as choices.
- Alternate names are kept only for cities of 1 million people or more (to keep the data small); smaller places are found by their GeoNames name.
- “Tomorrow” and bare times are taken in the source place’s calendar (the place you typed), not yours.
- Relative day labels (today/tomorrow) are relative to your Mac’s time zone.
- The planner assumes a Monday–Friday week except for a small table of countries with other weekends.

## Verify in real Alfred
- [ ] Rerun keeps the selected row while the minute ticks (uids mask digits)
- [ ] ⇧↩ add/remove and `clock add` ↩ go through the conditional to the action; Alfred reopens with `clock `
- [ ] ⌃↩ copies the ISO timestamp; ⌥↩ copies all cities; ⌘↩ pastes
- [ ] Autocomplete rows (ambiguous abbreviation, “use UTC−5 exactly”) replace the query and keep the keyword
- [ ] The Universal Action passes selected text like “3pm EST” to the converter
- [ ] Flag emoji render in titles; the ●◐○ marks line up well enough in the planner
- [ ] Workflow Configuration: keywords, time/date format, order, working hours, flags
- [ ] Screenshots for every `images/*.png` in the README

## Release checklist
- [x] README `## Usage`, “via the `kw` keyword”, `<kbd>` lists, Workflow’s Configuration, screenshot placeholders, `## Development`, `## AI disclosure`
- [x] Keywords ≥ 3 characters, configurable, no clash with the family or popular Gallery keywords (`now`/`meet`/`offset` of the Gallery World Clock avoided)
- [x] No dependencies, no binaries, no network, no hard-coded paths; `prefs.plist` ignored
- [x] GeoNames licence (CC BY 4.0) credited
- [x] `python3 tools/build.py --package` builds `dist/alfred-world-clock-1.0.0.alfredworkflow` with src files only
- [ ] GitHub release and forum post (by the author)

## Ideas for v1.1
1. Menu-bar-like Alfred 5.5 Text View or Grid View of the clock.
2. Reorder cities (move up/down) and groups (“Team”).
3. Sunrise/sunset times in the subtitle, and a “working hours now” badge per city.
4. Planner: half-hour rows, a longer range (`when … this week`), and creating a Calendar event for a chosen slot.
5. `clock 1727000000`: Unix timestamps as input (DevToolbox has `epoch`).
6. Per-city working hours for the planner.
7. More alternate names (all Latin-script names for cities over 100,000) if size allows.
