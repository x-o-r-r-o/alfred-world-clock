#!/usr/bin/env python3
"""Generate src/data/cities.tsv and src/data/meta.json (developer machine only; nothing here ships).

  python3 tools/make_cities.py [download-dir]

Source: GeoNames (https://www.geonames.org), licensed under Creative Commons Attribution 4.0
(https://creativecommons.org/licenses/by/4.0/). Files used: cities15000.zip (every populated place with at
least 15,000 people, or a capital), admin1CodesASCII.txt (states and provinces) and countryInfo.txt.
Time zones that have no such city (Chatham Islands, Lord Howe Island, Kiritimati…) are added from the
IANA zone.tab that ships with macOS (/usr/share/zoneinfo/zone.tab, public domain).

cities.tsv: one city per line, most populous first:
  key \t name \t country \t admin1 \t population \t zone index \t lat \t lon \t |alt|alt| (or empty)
`key` and the alternate names are folded (lower case, no accents, no punctuation) with fold() below,
which src/clock.js mirrors. meta.json: zones (index → IANA name), countries, admin1 names, zone.tab data.
"""
import csv, io, json, os, re, sys, unicodedata, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "data")
BASE = "https://download.geonames.org/export/dump/"
FILES = ["cities15000.zip", "admin1CodesASCII.txt", "countryInfo.txt"]
SKIP_CODES = {"PPLH", "PPLQ", "PPLW"}  # historical, abandoned, destroyed
ALT_MIN_POP = 1000000  # alternate names (Bombay, München, Wien…) only for big cities, to keep the file small
SPECIAL = {"ł": "l", "Ł": "l", "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss",
           "đ": "d", "Đ": "d", "ı": "i", "ħ": "h", "þ": "th", "ð": "d"}


def fold(s):
    s = "".join(SPECIAL.get(c, c) for c in s)
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"['’`.]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def fetch(folder, name):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        print("Downloading", name)
        urllib.request.urlretrieve(BASE + name, path)
    return path


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".geonames")
    os.makedirs(folder, exist_ok=True)
    paths = {n: fetch(folder, n) for n in FILES}
    with zipfile.ZipFile(paths["cities15000.zip"]) as z:
        raw = z.read("cities15000.txt").decode("utf-8")

    countries = {}
    for line in open(paths["countryInfo.txt"], encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        f = line.rstrip("\n").split("\t")
        countries[f[0]] = f[4]

    admin1 = {}
    for line in open(paths["admin1CodesASCII.txt"], encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if len(f) >= 2:
            admin1[f[0]] = f[1]

    zonetab = {}
    for line in open("/usr/share/zoneinfo/zone.tab", encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        cc, coord, zone = line.rstrip("\n").split("\t")[:3]
        m = re.fullmatch(r"([+-]\d{2})(\d{2})(\d{2})?([+-]\d{3})(\d{2})(\d{2})?", coord)
        lat = int(m.group(1)) + (1 if m.group(1)[0] == "+" else -1) * int(m.group(2)) / 60
        lon = int(m.group(4)) + (1 if m.group(4)[0] == "+" else -1) * int(m.group(5)) / 60
        zonetab[zone] = [cc, round(lat, 2), round(lon, 2)]

    rows = []
    for line in raw.splitlines():
        f = line.split("\t")
        if f[7] in SKIP_CODES or not f[17]:
            continue
        name, cc, a1, pop, zone = f[1], f[8], f[10], int(f[14] or 0), f[17]
        alts = set()
        if pop >= ALT_MIN_POP:
            for a in f[3].split(","):
                a = a.strip()
                if 3 <= len(a) <= 30 and a[0].isupper() and not a.isupper() and all(
                        unicodedata.name(c, "").startswith("LATIN") or c in " -'’." for c in a):
                    alts.add(fold(a))
        rows.append([fold(name) or fold(f[2]), name, cc, a1, pop, zone, round(float(f[4]), 2), round(float(f[5]), 2), alts])

    # Zones with no city of 15,000 people: add the zone's own place (from zone.tab)
    have = {r[5] for r in rows}
    for zone, (cc, lat, lon) in zonetab.items():
        if zone not in have:
            name = zone.rsplit("/", 1)[-1].replace("_", " ")
            rows.append([fold(name), name, cc, "", 0, zone, lat, lon, set()])

    rows.sort(key=lambda r: (-r[4], r[0]))
    zones = sorted({r[5] for r in rows} | set(zonetab))
    zidx = {z: i for i, z in enumerate(zones)}
    used_a1 = {f"{r[2]}.{r[3]}" for r in rows if r[3]}
    out = io.StringIO()
    for key, name, cc, a1, pop, zone, lat, lon, alts in rows:
        alts.discard(key)
        alt = "|" + "|".join(sorted(alts)) + "|" if alts else ""
        name = name.replace("\t", " ")
        out.write(f"{key}\t{name}\t{cc}\t{a1}\t{pop}\t{zidx[zone]}\t{lat:g}\t{lon:g}\t{alt}\n")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "cities.tsv"), "w", encoding="utf-8") as fh:
        fh.write(out.getvalue())
    meta = {
        "source": "GeoNames (geonames.org), CC BY 4.0; IANA zone.tab",
        "zones": zones,
        "countries": {k: countries[k] for k in sorted(countries)},
        "admin1": {k: admin1[k] for k in sorted(used_a1) if k in admin1},
        "zonetab": {k: zonetab[k] for k in sorted(zonetab)},
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    print(f"Wrote {len(rows)} cities, {len(zones)} zones")


if __name__ == "__main__":
    main()
