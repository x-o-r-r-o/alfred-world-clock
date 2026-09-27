#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters the way Alfred does and validate the JSON.

The clock (WC_NOW), the Mac's time zone (WC_TZ) and region (WC_LOCALE, WC_REGION) are injected, and the
saved cities live in a temporary data folder whose path has spaces, like Alfred's.
"""
import json, os, plistlib, re, shutil, subprocess, sys, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TMP = tempfile.mkdtemp(prefix="worldclock-test-")
BASE_ENV = {
    "WC_NOW": "2026-09-28T12:00:00Z",   # a Monday; NZ and Chatham are already on daylight time
    "WC_TZ": "Europe/London",
    "WC_LOCALE": "en_GB",
    "WC_REGION": "GB",
}


def data_dir(name="default"):
    d = os.path.join(TMP, name, "Application Support", "Alfred", "Workflow Data", "io.github.x-o-r-r-o.worldclock")
    return d


def run(cmd, query="", data=None, env_i=False, **env):
    e = dict(BASE_ENV, alfred_workflow_data=data or data_dir(), **env)
    e = {k: v for k, v in e.items() if v is not None}
    if env_i:
        base = {k: os.environ[k] for k in ("HOME", "USER", "TMPDIR") if k in os.environ}
        base["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        e = dict(base, **e)
    else:
        e = dict(os.environ, **e)
        for k in list(e):
            if k.startswith(("WC_", "keyword_", "time_format", "date_format", "sort_order", "work_", "show_flags")) and k not in dict(BASE_ENV, **env):
                del e[k]
    out = subprocess.run(["osascript", "-l", "JavaScript", "./clock.js", cmd, query], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return out.stdout


def sf(cmd, query="", **kw):
    raw = run(cmd, query, **kw)
    data = json.loads(raw)
    validate(data)
    return data


def items(cmd, query="", **kw):
    return sf(cmd, query, **kw)["items"]


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    uids = set()
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert not re.search(r"[\u0000-\u001f‪-‮⁦-⁩]", it["title"] + it.get("subtitle", "")), it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, it
        assert it.get("uid") and it["uid"] not in uids, it
        uids.add(it["uid"])


def find(its, prefix):
    for i in its:
        if re.sub(r"^[\U0001F1E6-\U0001F1FF]+ |^★ ", "", i["title"]).startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {[i['title'] for i in its]}")


def titles(its):
    return [i["title"] for i in its]


def fresh(name):
    d = data_dir(name)
    shutil.rmtree(d, ignore_errors=True)
    return d


def save(d, cities):
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "cities.json"), "w") as f:
        json.dump({"version": 1, "cities": cities}, f)


class WorldClockTests(unittest.TestCase):
    def test_default_cities(self):
        data = sf("clock", data=fresh("wc1"))
        its = data["items"]
        self.assertEqual(its[0]["title"], "🇬🇧 London (here)  13:00")
        self.assertEqual(find(its, "New York")["title"], "🇺🇸 New York  08:00")
        tokyo = find(its, "Tokyo")
        self.assertEqual(tokyo["title"], "🇯🇵 Tokyo  21:00")
        self.assertIn("+8 h", tokyo["subtitle"])
        self.assertIn("JST (UTC+9)", tokyo["subtitle"])
        self.assertEqual(tokyo["arg"], "21:00 JST, Mon 28 Sep")
        # London is here, so the saved London isn't listed twice
        self.assertEqual(sum("London" in t for t in titles(its)), 1)
        self.assertIn("rerun", data)
        self.assertTrue(data["skipknowledge"])

    def test_mods(self):
        tokyo = find(items("clock", data=fresh("wc2")), "Tokyo")
        m = tokyo["mods"]
        self.assertEqual(m["cmd"]["arg"], tokyo["arg"])
        self.assertEqual(m["ctrl"]["arg"], "2026-09-28T21:00:00+09:00")
        lines = m["alt"]["arg"].split("\n")
        self.assertEqual(lines[0], "London: 13:00 BST, Mon 28 Sep")
        self.assertIn("Tokyo: 21:00 JST, Mon 28 Sep", lines)
        self.assertTrue(m["shift"]["arg"].startswith("wcfav:"))
        self.assertIn('"op":"remove"', m["shift"]["arg"])
        self.assertEqual(tokyo["text"]["copy"], tokyo["arg"])

    def test_12h_same_as_macos(self):
        # en_US uses a 12-hour short time style (h:mm a), en_GB and de_DE 24-hour (HH:mm)
        its = items("clock", data=fresh("wc3"), WC_LOCALE="en_US")
        self.assertEqual(find(its, "Tokyo")["title"], "🇯🇵 Tokyo  9:00 PM")
        its = items("clock", data=fresh("wc3"), WC_LOCALE="de_DE")
        self.assertEqual(find(its, "Tokyo")["title"], "🇯🇵 Tokyo  21:00")
        its = items("clock", data=fresh("wc3"), WC_LOCALE="en_US", time_format="24")
        self.assertEqual(find(its, "Tokyo")["title"], "🇯🇵 Tokyo  21:00")
        its = items("clock", data=fresh("wc3"), WC_LOCALE="en_GB", time_format=" 12 ")
        self.assertEqual(find(its, "Tokyo")["title"], "🇯🇵 Tokyo  9:00 PM")
        # zh_TW: "Bh:mm" day periods without "a" are still 12-hour
        its = items("clock", data=fresh("wc3"), WC_LOCALE="zh_TW")
        self.assertIn("PM", find(its, "Tokyo")["title"])

    def test_date_order(self):
        its = items("clock", data=fresh("wc4"), WC_LOCALE="en_US")
        self.assertTrue(find(its, "Tokyo")["subtitle"].startswith("Mon Sep 28"))
        its = items("clock", data=fresh("wc4"), date_format="dmy", WC_LOCALE="en_US")
        self.assertTrue(find(its, "Tokyo")["subtitle"].startswith("Mon 28 Sep"))

    def test_injected_zone_and_day_labels(self):
        its = items("clock", data=fresh("wc5"), WC_TZ="Pacific/Auckland")
        self.assertTrue(its[0]["title"].startswith("🇳🇿 Auckland (here)  01:00"))
        ny = find(its, "New York")
        self.assertIn("(yesterday)", ny["subtitle"])
        self.assertTrue(ny["title"].endswith("08:00 Mon"))
        self.assertIn("−17 h", ny["subtitle"])

    def test_day_night_icons(self):
        its = items("clock", data=fresh("wc6"))
        self.assertEqual(find(its, "London")["icon"]["path"], "icons/day.png")      # 13:00 in London
        self.assertEqual(find(its, "Tokyo")["icon"]["path"], "icons/night.png")     # 21:00 in Tokyo
        its = items("clock", data=fresh("wc6"), WC_NOW="2026-09-28T05:40:00Z")      # ~06:40 in London: sunrise
        self.assertEqual(its[0]["icon"]["path"], "icons/sunrise.png")
        its = items("clock", "UTC", data=fresh("wc6"))                               # no coordinates: by the hour
        self.assertEqual(its[0]["icon"]["path"], "icons/day.png")

    def test_order_and_flags_config(self):
        d = fresh("wc7")
        save(d, [{"name": "Tokyo", "cc": "JP", "zone": "Asia/Tokyo"}, {"name": "Los Angeles", "cc": "US", "zone": "America/Los_Angeles"}])
        its = items("clock", data=d)
        self.assertEqual([re.sub(r"^\S+ ", "", t).split("  ")[0] for t in titles(its)[1:]], ["Los Angeles", "Tokyo"])
        its = items("clock", data=d, sort_order="added")
        self.assertEqual([re.sub(r"^\S+ ", "", t).split("  ")[0] for t in titles(its)[1:]], ["Tokyo", "Los Angeles"])
        its = items("clock", data=d, show_flags="0")
        self.assertEqual(its[1]["title"], "Los Angeles  05:00")

    def test_dst_note(self):
        # Sydney goes forward on Sun 4 Oct 2026
        d = fresh("wc8")
        save(d, [{"name": "Sydney", "cc": "AU", "zone": "Australia/Sydney", "lat": -33.87, "lon": 151.21}])
        s = find(items("clock", data=d), "Sydney")
        self.assertIn("clocks go forward 1 h Sun 4 Oct", s["subtitle"])
        self.assertIn("AEST (UTC+10)", s["subtitle"])

    def test_empty_list_and_damaged_file(self):
        d = fresh("wc9")
        save(d, [])
        its = items("clock", data=d)
        self.assertEqual(its[-1]["title"], "Add a city")
        self.assertEqual(its[-1]["autocomplete"], "add ")
        with open(os.path.join(d, "cities.json"), "w") as f:
            f.write("{not json")
        its = items("clock", data=d)
        self.assertEqual(its[0]["title"], "Couldn’t read your saved cities")
        # a hostile file: bad zones and paths are dropped, not opened
        save(d, [{"name": "X", "zone": "../../../etc/passwd"}, {"name": "Y", "zone": "Asia/Tokyo", "lat": "x"}, "junk", {"name": "Z", "fixed": 99999}])
        its = items("clock", data=d)
        self.assertEqual(len(its), 2)
        self.assertTrue(its[1]["title"].startswith("Y  21:00"))


class ConverterTests(unittest.TestCase):
    def conv(self, q, **kw):
        return items("clock", q, data=kw.pop("data", fresh("conv")), **kw)

    def test_examples_from_the_brief(self):
        its = self.conv("3pm PST in Tokyo", WC_LOCALE="en_US")
        self.assertTrue(its[0]["title"].endswith("US Pacific time  3:00 PM"))
        self.assertEqual(find(its, "Tokyo")["title"], "🇯🇵 Tokyo  7:00 AM Tue")
        its = self.conv("tomorrow 9:00 London to NYC")
        self.assertEqual(its[0]["title"], "🇬🇧 London  09:00")
        self.assertIn("Tue 29 Sep (tomorrow)", its[0]["subtitle"])
        self.assertEqual(find(its, "New York")["arg"], "04:00 EDT, Tue 29 Sep")
        its = self.conv("noon here in Berlin")
        self.assertEqual(find(its, "Berlin")["arg"], "13:00 CEST, Mon 28 Sep")
        its = self.conv("now in Sydney")
        self.assertEqual(find(its, "Sydney")["arg"], "22:00 AEST, Mon 28 Sep")
        its = self.conv("14:30 CET")
        # audit 3: no French flag on CET (Paris only stands in for the zone)
        self.assertEqual(its[0]["title"], "Central European time  14:30")
        self.assertEqual(find(its, "London")["arg"], "13:30 BST, Mon 28 Sep")
        self.assertEqual(find(its, "Tokyo")["arg"], "21:30 JST, Mon 28 Sep")

    def test_strict_abbreviation_note(self):
        its = self.conv("3pm EST in London")
        note = find(its, "EST is UTC−5")
        self.assertEqual(note["autocomplete"], "3pm UTC-5 in London")
        self.assertEqual(find(its, "London")["arg"], "20:00 BST, Mon 28 Sep")
        its = self.conv("3pm UTC-5 in London")
        self.assertEqual(find(its, "London")["arg"], "21:00 BST, Mon 28 Sep")
        # in January EST is right: no note
        its = self.conv("3pm EST Jan 15 in London")
        self.assertFalse(any(t.startswith("EST is") for t in titles(its)))
        self.assertEqual(find(its, "London")["arg"], "20:00 GMT, Fri 15 Jan 2027")

    def test_ambiguous_abbreviations(self):
        its = self.conv("9am CST to London")
        self.assertIn("US Central", its[0]["title"])
        china = find(its, "Use China Standard time")
        self.assertEqual(china["autocomplete"], "9am Asia/Shanghai to London")
        self.assertEqual(find(self.conv(china["autocomplete"]), "London")["arg"], "02:00 BST, Mon 28 Sep")
        # the region decides the default
        its = self.conv("9am CST to London", WC_REGION="CN")
        self.assertIn("China Standard", its[0]["title"])
        its = self.conv("IST", WC_REGION="IE")
        self.assertIn("“IST” has 3 meanings", titles(its)[0])
        self.assertIn("Irish", titles(its)[1])
        its = self.conv("noon IST to UTC", WC_REGION="US")
        self.assertIn("India", its[0]["title"])
        self.assertEqual(find(its, "UTC")["arg"], "06:30 UTC, Mon 28 Sep")
        its = self.conv("noon BST to UTC", WC_REGION="BD")
        self.assertIn("Bangladesh", its[0]["title"])
        self.assertEqual(find(its, "UTC")["arg"], "06:00 UTC, Mon 28 Sep")

    def test_dst_northern_hemisphere(self):
        # New York: 2:30 AM doesn't exist on 8 Mar 2026; 1:30 AM happens twice on 1 Nov 2026
        its = self.conv("2:30am New York to UTC on 2027-03-14")
        self.assertIn("doesn’t exist in New York", titles(its)[1])
        self.assertEqual(find(its, "UTC")["arg"], "07:30 UTC, Sun 14 Mar 2027")
        its = self.conv("1:30am New York Nov 1 to UTC")
        self.assertIn("happens twice in New York", titles(its)[1])
        self.assertIn("EST (UTC−5)", its[1]["subtitle"])
        self.assertEqual(find(its, "UTC")["arg"], "05:30 UTC, Sun 1 Nov")
        # the converted time is in winter: the note says so
        its = self.conv("noon London Dec 1 to New York")
        ny = find(its, "New York")
        self.assertEqual(ny["arg"], "07:00 EST, Tue 1 Dec")
        self.assertIn("EST then, EDT now", ny["subtitle"])

    def test_dst_southern_hemisphere(self):
        its = self.conv("2:30am Sydney 4 Oct to UTC")
        self.assertIn("02:30 doesn’t exist in Sydney", titles(its)[1])
        self.assertEqual(find(its, "UTC")["arg"], "16:30 UTC, Sat 3 Oct")
        its = self.conv("2:30am Sydney 4 Apr 2027 to UTC")
        self.assertIn("happens twice", titles(its)[1])
        self.assertEqual(find(its, "UTC")["arg"], "15:30 UTC, Sat 3 Apr 2027")
        # Santiago (Chile) and Lord Howe (a 30-minute change)
        its = self.conv("noon Santiago Jan 15 to UTC")
        self.assertEqual(find(its, "UTC")["arg"], "15:00 UTC, Fri 15 Jan 2027")
        its = self.conv("noon Santiago Jul 15 to UTC")
        self.assertEqual(find(its, "UTC")["arg"], "16:00 UTC, Thu 15 Jul 2027")
        its = self.conv("2:15 Lord Howe 4 Oct to UTC")
        self.assertIn("doesn’t exist", titles(its)[1])
        self.assertEqual(its[0]["title"], "🇦🇺 Lord Howe  02:45")
        its = self.conv("noon utc 1 Nov to Lord Howe")
        self.assertEqual(find(its, "Lord Howe")["arg"], "23:00 LHDT, Sun 1 Nov")

    def test_date_line(self):
        its = self.conv("noon Honolulu to Kiritimati")
        k = find(its, "Kiritimati")
        self.assertEqual(k["arg"], "12:00 LINT, Tue 29 Sep")
        self.assertIn("+24 h from Honolulu", k["subtitle"])
        its = self.conv("noon Pago Pago to Apia")
        self.assertEqual(find(its, "Apia")["arg"], "12:00 in Apia (UTC+13), Tue 29 Sep")
        its = self.conv("11pm Auckland to Honolulu")
        # 11pm today in Auckland (Tue 29) is midnight on Tue 29 in Honolulu, a day behind on the clock face
        self.assertEqual(find(its, "Honolulu")["arg"], "00:00 HST, Tue 29 Sep")

    def test_half_and_quarter_hour_offsets(self):
        its = self.conv("9:00 UTC to Kolkata, Kathmandu and Chatham")
        self.assertEqual(find(its, "Kolkata")["arg"], "14:30 IST, Mon 28 Sep")
        self.assertEqual(find(its, "Kathmandu")["arg"], "14:45 NPT, Mon 28 Sep")
        self.assertEqual(find(its, "Chatham")["arg"], "22:45 CHADT, Mon 28 Sep")
        its = self.conv("0:00 UTC 15 Jul 2027 to Chatham")
        self.assertEqual(find(its, "Chatham")["arg"], "12:45 CHAST, Thu 15 Jul 2027")
        self.assertIn("+12 h 45 min from UTC", find(its, "Chatham")["subtitle"])
        its = self.conv("noon Kathmandu in Kolkata")
        self.assertIn("−15 min from Kathmandu", find(its, "Kolkata")["subtitle"])
        its = self.conv("noon Adelaide Jul 1 to UTC")
        self.assertEqual(find(its, "UTC")["arg"], "02:30 UTC, Thu 1 Jul 2027")

    def test_iso_and_relative(self):
        its = self.conv("2026-10-05T14:00Z in Tokyo")
        self.assertEqual(find(its, "Tokyo")["arg"], "23:00 JST, Mon 5 Oct")
        its = self.conv("2026-10-05 14:00+05:30 in UTC")
        self.assertEqual(its[0]["arg"], "14:00 UTC+5:30, Mon 5 Oct")
        self.assertEqual(its[-1]["arg"], "08:30 UTC, Mon 5 Oct")
        its = self.conv("in 2 hours in Tokyo")
        self.assertEqual(find(its, "Tokyo")["arg"], "23:00 JST, Mon 28 Sep")
        its = self.conv("+90m in Tokyo")
        self.assertEqual(find(its, "Tokyo")["arg"], "22:30 JST, Mon 28 Sep")
        its = self.conv("3 days ago in Tokyo")
        self.assertEqual(find(its, "Tokyo")["arg"], "21:00 JST, Fri 25 Sep")

    def test_places_in_many_forms(self):
        cases = {
            "noon utc to nyc": ("New York", "08:00 EDT"),
            "noon utc to Bombay": ("Mumbai", "17:30 IST"),
            "noon utc to münchen": ("Munich", "14:00 CEST"),
            "noon utc to Portland, Maine": ("Portland", "08:00 EDT"),
            "noon utc to Paris Texas": ("Paris", "07:00 CDT"),
            "noon utc to Utah": ("Salt Lake City", "06:00 MDT"),
            "noon utc to Japan": ("Tokyo", "21:00 JST"),
            "noon utc to America/Chicago": ("Chicago", "07:00 CDT"),
            "noon utc to Europe/Kyiv": ("Kyiv", "15:00 EEST"),
            "noon utc to UTC+5:30": ("UTC+5:30", "17:30 UTC+5:30"),
            "noon utc to GMT-3": ("UTC−3", "09:00 UTC−3"),
            "noon utc to AoE": ("Anywhere on Earth", "00:00 AoE"),
            "noon utc to Tokyo, Japan": ("Tokyo", "21:00 JST"),
        }
        for q, (name, arg) in cases.items():
            its = self.conv(q)
            self.assertTrue(find(its, name)["arg"].startswith(arg), (q, titles(its)))

    def test_several_targets_and_typing(self):
        its = self.conv("5pm PT Shanghai Zurich")
        self.assertTrue(its[0]["title"].endswith("US Pacific time  17:00"))
        self.assertEqual(find(its, "Shanghai")["arg"], "08:00 CST, Tue 29 Sep")
        self.assertEqual(find(its, "Zürich")["arg"], "02:00 CEST, Tue 29 Sep")
        its = self.conv("3pm london to tokyo sydney")
        self.assertEqual(len([t for t in titles(its) if "Tokyo" in t or "Sydney" in t]), 2)
        # still typing the last city
        its = self.conv("3pm london to tok")
        self.assertEqual(find(its, "Tokyo")["arg"], "23:00 JST, Mon 28 Sep")
        # the date may come after the cities
        its = self.conv("London to NYC tomorrow 9am")
        self.assertEqual(find(its, "New York")["arg"], "04:00 EDT, Tue 29 Sep")
        # a trailing separator while typing
        its = self.conv("3pm Tokyo in")
        self.assertTrue(its[0]["title"].endswith("Tokyo  15:00"))

    def test_typing_states(self):
        # audit 2: no dead ends while a query is half typed
        self.assertEqual(self.conv("3pm P")[0]["title"], "Keep typing a place")
        its = self.conv("3pm PST i")
        self.assertTrue(its[0]["title"].endswith("US Pacific time  15:00"))
        its = self.conv("3pm PST in T")
        self.assertIn("Tokyo", " ".join(titles(its)))   # the saved cities meanwhile
        its = self.conv("London NYC")
        self.assertEqual([t.split("  ")[0] for t in titles(its)], ["🇬🇧 London", "🇺🇸 New York"])
        self.assertEqual(its[1]["mods"]["alt"]["arg"], "London: 13:00 BST, Mon 28 Sep\nNew York: 08:00 EDT, Mon 28 Sep")

    def test_ambiguous_city(self):
        its = self.conv("3pm in Portland")
        self.assertIn("Oregon", find(its, "“Portland” is ambiguous")["title"])
        alt = find(its, "Use Portland, Maine")
        self.assertEqual(alt["autocomplete"], "3pm in Portland Maine")
        self.assertEqual(find(self.conv(alt["autocomplete"]), "Portland")["arg"], "10:00 EDT, Mon 28 Sep")
        # Chatham means the Chatham Islands' zone first
        its = self.conv("9am Kathmandu in Chatham")
        self.assertIn("CHADT", find(its, "Chatham")["arg"])

    def test_time_formats(self):
        cases = {"1530": "15:30", "930": "09:30", "3.30pm": "15:30", "9h30": "09:30", "9h": "09:00", "noon": "12:00",
                 "midnight": "00:00", "12am": "00:00", "12pm": "12:00", "3 pm": "15:00", "3p": "15:00", "7 a.m.": "07:00",
                 "15:30:45": "15:30", "9": "09:00"}
        for q, want in cases.items():
            its = self.conv(q + " utc to utc+1")
            self.assertTrue(its[0]["title"].endswith(want), (q, its[0]["title"]))

    def test_dates(self):
        def day(q, **kw):
            return self.conv(q + " to UTC", **kw)[0]["subtitle"].split(" · ")[0]
        self.assertEqual(day("noon London tomorrow"), "Tue 29 Sep (tomorrow)")
        self.assertEqual(day("noon London yesterday"), "Sun 27 Sep (yesterday)")
        self.assertEqual(day("noon London Friday"), "Fri 2 Oct")
        self.assertEqual(day("noon London Monday"), "Mon 28 Sep (today)")
        self.assertEqual(day("noon London next monday"), "Mon 5 Oct")
        self.assertEqual(day("noon London 5 Oct"), "Mon 5 Oct")
        self.assertEqual(day("noon London October 5th"), "Mon 5 Oct")
        self.assertEqual(day("noon London 3 Feb"), "Wed 3 Feb 2027")
        self.assertEqual(day("noon London 10/5"), "Mon 10 May 2027")
        self.assertEqual(day("noon London 10/5", WC_LOCALE="en_US"), "Mon Oct 5")
        self.assertEqual(day("noon London 5.10."), "Mon 5 Oct")
        self.assertEqual(day("noon London 2026-12-25"), "Fri 25 Dec")

    def test_errors(self):
        self.assertEqual(self.conv("25:00 London")[0]["title"], "Couldn’t read the time “25:00”")
        self.assertEqual(self.conv("13pm")[0]["title"], "Couldn’t read the time “13pm”")
        self.assertEqual(self.conv("Feb 30 3pm")[0]["title"], "Couldn’t read the date")
        self.assertEqual(self.conv("3pm Xyzzyq")[0]["title"], "Couldn’t find “Xyzzyq”")
        its = self.conv("3pm to London Qqqzz")
        self.assertIn("Couldn’t find “Qqqzz”", titles(its))

    def test_nasty_input(self):
        for q in ["constructor", "__proto__", "toString", "\"'`$(rm -rf ~)", "a\nb\tc", "‮evil", "🙂", "a" * 500,
                  "Europe/../../etc/passwd", "3pm in in in", "to", "in", "--", "UTC+99", "3pm \\ Tokyo"]:
            self.conv(q)   # valid JSON, no crash

    def test_lookup_and_search(self):
        its = self.conv("tok")
        self.assertTrue(its[0]["title"].startswith("★ 🇯🇵 Tokyo"))
        self.assertIn("rerun", sf("clock", "tok", data=fresh("conv")))
        its = self.conv("IST")
        self.assertEqual(len(its), 4)   # the note and the three meanings, not Istanbul
        its = self.conv("Rio de Janeiro")
        self.assertTrue(its[0]["title"].startswith("🇧🇷 Rio de Janeiro"))
        self.assertIn("Rio de Janeiro, Brazil", its[0]["subtitle"])
        add = its[0]["mods"]["shift"]
        self.assertIn('"op":"add"', add["arg"])
        # audit 1: ⌥↩ on a lookup copies every listed place, as its subtitle says
        its = self.conv("IST")
        self.assertEqual(len(its[1]["mods"]["alt"]["arg"].split("\n")), 3)

    def test_tonight_and_today(self):
        its = self.conv("tonight in Tokyo")
        self.assertEqual(its[0]["arg"], "20:00 BST, Mon 28 Sep")
        its = self.conv("today in Tokyo")
        self.assertEqual(find(its, "Tokyo")["arg"], "21:00 JST, Mon 28 Sep")


class AddTests(unittest.TestCase):
    def act(self, arg, d):
        out = run("act", arg, data=d)
        self.assertEqual(out.strip(), "")

    def saved(self, d):
        with open(os.path.join(d, "cities.json")) as f:
            return json.load(f)["cities"]

    def test_add_remove_rename(self):
        d = fresh("add1")
        its = items("clock", "add", data=d)
        self.assertEqual(its[0]["title"], "Add a city to the world clock")
        self.assertEqual(len(its), 4)   # the hint and the three default cities, each removable
        self.assertIn('"op":"remove"', its[1]["arg"])
        its = items("clock", "add chatham as Kiwi office", data=d)
        self.assertIn("as “Kiwi office”", its[0]["subtitle"])
        self.act(its[0]["arg"], d)
        c = self.saved(d)[-1]
        self.assertEqual((c["name"], c["zone"], c["label"]), ("Chatham", "Pacific/Chatham", "Kiwi office"))
        its = items("clock", data=d)
        k = find(its, "Kiwi office (Chatham)")
        self.assertIn("CHADT", k["subtitle"])
        # rename, then remove
        its = items("clock", "add chatham as Kiwi", data=d)
        self.assertIn("Rename", its[0]["subtitle"])
        self.act(its[0]["arg"], d)
        self.assertEqual(self.saved(d)[-1]["label"], "Kiwi")
        its = items("clock", "add chatham", data=d)
        self.assertTrue(its[0]["title"].startswith("★"))
        self.act(its[0]["arg"], d)
        self.assertNotIn("Pacific/Chatham", [x.get("zone") for x in self.saved(d)])

    def test_add_zone_offset_and_abbreviation(self):
        d = fresh("add2")
        for q in ["UTC", "UTC+5:30", "CET"]:
            self.act(items("clock", "add " + q, data=d)[0]["arg"], d)
        s = self.saved(d)
        self.assertEqual(s[-3]["zone"], "UTC")
        self.assertEqual(s[-2]["fixed"], 19800)
        self.assertEqual(s[-1]["zone"], "Europe/Paris")
        its = items("clock", data=d)
        self.assertTrue(any(t.startswith("UTC+5:30  17:30") for t in titles(its)))

    def test_shift_toggle_from_lookup(self):
        d = fresh("add3")
        its = items("clock", "Lagos", data=d)
        self.act(its[0]["mods"]["shift"]["arg"], d)
        self.assertEqual(self.saved(d)[-1]["name"], "Lagos")
        its = items("clock", data=d)
        self.assertIn('"op":"remove"', find(its, "Lagos")["mods"]["shift"]["arg"])

    def test_act_rejects_bad_payloads(self):
        d = fresh("add4")
        for arg in ["", "hello", "wcfav:", "wcfav:{bad", 'wcfav:{"op":"add","name":"X","zone":"../../etc/passwd"}',
                    'wcfav:{"op":"nuke","name":"X","zone":"Asia/Tokyo"}', 'wcfav:{"op":"add","name":"","zone":"Asia/Tokyo"}']:
            self.act(arg, d)
        self.assertFalse(os.path.exists(os.path.join(d, "cities.json")))

    def test_here_cannot_be_added(self):
        its = items("clock", data=fresh("add5"))
        self.assertIs(its[0]["mods"]["shift"].get("valid"), False)


class PlannerTests(unittest.TestCase):
    def test_grid(self):
        its = items("when", "London NYC Tokyo", data=fresh("pl1"))
        self.assertEqual(len(its), 25)   # the best time and 24 hours
        self.assertEqual(its[1]["title"], "● 13:00 London   ◐ 08:00 New York   ◐ 21:00 Tokyo")
        best = its[0]
        self.assertTrue(best["title"].startswith("Closest: "))   # no hour has all three at work
        self.assertIn("2 of 3", best["subtitle"])
        row = find(its, "● 14:00 London")
        self.assertEqual(row["arg"], "Mon 28 Sep: 14:00 London / 09:00 New York / 22:00 Tokyo")
        self.assertEqual(row["mods"]["ctrl"]["arg"], "2026-09-28T14:00:00+01:00")
        self.assertEqual(len(row["mods"]["alt"]["arg"].split("\n")), 24)

    def test_everyone_at_work(self):
        its = items("when", "Berlin Paris", data=fresh("pl2"))
        self.assertTrue(its[0]["title"].startswith("Best: 13:00–16:00 Mon 28 Sep"), its[0]["title"])
        self.assertEqual(its[0]["icon"]["path"], "icons/best.png")

    def test_day_and_working_hours_config(self):
        its = items("when", "London NYC tomorrow", data=fresh("pl3"), work_start="8", work_end=" 18 ")
        self.assertTrue(its[1]["subtitle"].startswith("Tue 29 Sep 00:00"))
        self.assertTrue(its[0]["title"].startswith("Best: 13:00–18:00 Tue 29 Sep"), its[0]["title"])
        its = items("when", "London NYC tomorrow", data=fresh("pl3"), work_start="", work_end="junk")
        self.assertTrue(its[0]["title"].startswith("Best: 14:00–17:00"), its[0]["title"])

    def test_weekends(self):
        # Friday 2 Oct: Riyadh's weekend (Fri–Sat), a working day in London
        its = items("when", "Riyadh Friday", data=fresh("pl4"))
        row = find(its, "● 10:00 London")
        self.assertIn("◐ 12:00 Riyadh", row["title"])
        its = items("when", "Riyadh Sunday", data=fresh("pl4"))
        self.assertIn("● 12:00 Riyadh", find(its, "◐ 10:00 London")["title"])

    def test_output_size(self):
        # audit 2: the grid in every row's ⌥ made the JSON ~100 KB with six cities
        raw = run("when", "London NYC Tokyo Sydney Paris Berlin", data=fresh("pl6"))
        self.assertLess(len(raw.encode()), 50000)
        its = json.loads(raw)["items"]
        self.assertEqual(len(its[0]["mods"]["alt"]["arg"].split("\n")), 24)
        self.assertIs(its[1]["mods"]["alt"]["valid"], False)
        its = items("when", "London NYC", data=fresh("pl6"))
        self.assertEqual(len(its[5]["mods"]["alt"]["arg"].split("\n")), 24)

    def test_quarter_hours_and_favourites(self):
        its = items("when", "Kathmandu", data=fresh("pl5"))
        self.assertIn("17:45 Kathmandu", its[1]["title"])
        its = items("when", "", data=fresh("pl5"))
        self.assertIn("Tokyo", its[1]["title"])
        its = items("when", "Qqqzz", data=fresh("pl5"))
        self.assertEqual(its[0]["title"], "Couldn’t find “Qqqzz”")


class RuntimeTests(unittest.TestCase):
    def test_env_i_like_alfred(self):
        # no LANG, bare PATH, data folder with spaces that doesn't exist yet
        d = fresh("envi")
        for cmd, q in [("clock", ""), ("clock", "3pm PST in Tokyo"), ("when", "London NYC"), ("clock", "add tok")]:
            data = json.loads(run(cmd, q, data=d, env_i=True))
            validate(data)
        arg = json.loads(run("clock", "add Lima", data=d, env_i=True))["items"][0]["arg"]
        run("act", arg, data=d, env_i=True)
        self.assertTrue(os.path.exists(os.path.join(d, "cities.json")))

    def test_real_clock_and_zone(self):
        # without overrides: the Mac's time zone and the real time (no saved cities are read: the data folder is empty)
        e = {k: None for k in BASE_ENV}
        data = sf("clock", "", data=fresh("real"), WC_TEST="1", **e)
        self.assertTrue(data["items"][0]["title"].endswith(("(here)  " + time.strftime("%H:%M"), "(here)  " + time.strftime("%H:%M", time.localtime(time.time() - 60)))) or "(here)" in data["items"][0]["title"])
        self.assertLessEqual(data["rerun"], 5)

    def test_speed(self):
        d = fresh("speed")
        for cmd, q in [("clock", ""), ("clock", "3pm PST in Tokyo, London and Sydney"), ("clock", "san"), ("when", "London NYC Tokyo"), ("clock", "add por")]:
            t = time.time()
            run(cmd, q, data=d)
            self.assertLess(time.time() - t, 0.6, (cmd, q))

    def test_keyword_in_hints(self):
        d = fresh("kw")
        save(d, [])
        its = items("clock", "3pm", data=d, keyword_clock="  tz  ")
        self.assertIn("“tz add”", find(its, "No cities")["subtitle"])


class BuildTests(unittest.TestCase):
    def test_build(self):
        out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        info = plistlib.load(open(os.path.join(SRC, "info.plist"), "rb").__enter__())
        kws = {o["config"].get("keyword") for o in info["objects"]}
        self.assertEqual(kws - {None}, {"{var:keyword_clock}", "{var:keyword_when}"})
        self.assertIn("## Usage", info["readme"])

    def test_data_file(self):
        with open(os.path.join(SRC, "data", "cities.tsv"), encoding="utf-8") as f:
            lines = f.read().split("\n")
        self.assertGreater(len(lines), 30000)
        meta = json.load(open(os.path.join(SRC, "data", "meta.json"), encoding="utf-8"))
        for line in lines[:2000]:
            if not line:
                continue
            f = line.split("\t")
            self.assertEqual(len(f), 9, line)
            self.assertTrue(0 <= int(f[5]) < len(meta["zones"]))

    def test_curly_apostrophes(self):
        js = open(os.path.join(SRC, "clock.js"), encoding="utf-8").read()
        js = re.sub(r"(?m)^\s*//.*$|\s//\s.*$", "", js)
        strings = re.findall(r'`[^`]*`|"(?:[^"\\\n]|\\.)*"', js)
        bad = [x for x in strings if re.search(r"[A-Za-z]'[a-z]", x)]
        self.assertEqual(bad, [])

    def test_macos13_syntax(self):
        # audit 1: regex lookbehind needs JavaScriptCore from macOS 13.3; the workflow supports 13.0
        js = open(os.path.join(SRC, "clock.js"), encoding="utf-8").read()
        self.assertNotIn("(?<=", js)
        self.assertNotIn("(?<!", js)

    def test_fold_matches_tool(self):
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import make_cities
        words = ["São Paulo", "Łódź", "Zürich", "Ho Chi Minh City", "St. John's", "Hà Nội", "Reykjavík", "Ålesund", "Kraków"]
        for w in words:
            data = sf("clock", "add " + w, data=fresh("fold"))
            self.assertNotEqual(data["items"][0]["title"].split("  ")[0], "Couldn’t find", w)
            self.assertIn(make_cities.fold(w), open(os.path.join(SRC, "data", "cities.tsv"), encoding="utf-8").read())


if __name__ == "__main__":
    unittest.main(verbosity=1)
