"""Static transit overlay (rail + ferry lines, stations) → public/data/transit.json.

Sources:
  - Rapid Rail KL GTFS (colours, stations)      → LRT / MRT / Monorail / BRT, geometry from OSM
                                                  relations (GTFS shape + Chaikin as fallback)
  - KTMB GTFS (stations + stop order, no shapes) → Komuter / ETS, routed over OSM track
  - OSM extract (osmium CLI)                     → KLIA Ekspres/Transit relations, ferry ways

Run: python3 gtfs/transit.py
"""
from __future__ import annotations

import csv, heapq, io, json, math, re, subprocess, urllib.request, zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable, NamedTuple

import shapely
from shapely import LineString, MultiLineString, STRtree, Point
from shapely.ops import linemerge, nearest_points, unary_union

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "transit.json"
TMP = Path("/tmp")
RAIL, KTM = TMP / "rail", TMP / "ktm"
PBF = Path.home() / "valhalla/malaysia/malaysia-singapore-brunei-latest.osm.pbf"
CACHE_PBF, CACHE_GEO = TMP / "transit-overlay-v3.osm.pbf", TMP / "transit-overlay-v3.geojsonseq"
FEEDS = {
    RAIL: "https://api.data.gov.my/gtfs-static/prasarana?category=rapid-rail-kl",
    KTM: "https://api.data.gov.my/gtfs-static/ktmb",
}

SIMPLIFY = 0.00003  # deg ≈ 3 m: keeps curves smooth
DEDUPE = 0.00025    # deg ≈ 28 m: parallel tracks closer than this collapse into one
MERGE_M = 300       # same-named stations within this distance become one

Coords = list[list[list[float]]]


class Line(NamedTuple):
    id: str
    name: str
    short: str
    mode: str
    color: str
    geom: MultiLineString


# ---------- small helpers ----------

def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def ensure_feed(d: Path) -> None:
    if (d / "stops.txt").exists():
        return
    with urllib.request.urlopen(FEEDS[d]) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(d)


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Equirectangular distance; plenty accurate at Malaysian latitudes."""
    kx = 111_320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110_574)


ACRONYMS = {"KL", "KLCC", "LRT", "MRT", "TBS", "UTM", "UKM", "USJ", "KTM", "BRT", "KLIA", "IOI", "TRX",
            "PJ", "OUG", "UPM", "UIA", "TTDI", "SBK", "PKNS", "MSU", "KWSP", "BTS", "JB", "PPR", "SS",
            "SPK", "HQ", "KPJ", "ERL", "UM", "RTM", "PWTC", "SMK", "IKEA", "UOA", "UOB", "CBP", "SA"}
ABBR = {"BDR": "Bandar", "PEL": "Pelabuhan", "SEL": "Selatan", "JLN": "Jalan", "KG": "Kampung", "TMN": "Taman"}
FIXES = {"UITM": "UiTM", "SUNU": "SunU"}
SMALL = {"dan", "ke", "di", "of", "the", "and"}


def nice(name: str) -> str:
    """ALL CAPS GTFS name → Title Case, keeping acronyms / codes (SS 15, USJ7), expanding KTM abbreviations."""
    def word(w: str, first: bool) -> str:
        u = w.upper()
        if u in FIXES:
            return FIXES[u]
        if u in ABBR:
            return ABBR[u]
        if u in ACRONYMS or (re.search(r"\d", w) and re.search(r"[A-Za-z]", w)):
            return u
        if not first and w.lower() in SMALL:
            return w.lower()
        return w[:1].upper() + w[1:].lower()
    # split on spaces, hyphens and slashes but keep them
    name = name.split(" - ")[0].strip()  # drop sponsor suffixes: "BANGSAR - BANK RAKYAT" → Bangsar
    toks = re.split(r"([\s\-/]+)", name)
    return "".join(t if i % 2 else word(t, i == 0) for i, t in enumerate(toks))


def norm(name: str) -> str:
    """Key used to match the same station across operators."""
    n = re.sub(r"\b(LRT|MRT|KTM|ERL|BRT|MONORAIL|STESEN|STATION)\b|[^A-Z0-9 ]", " ", name.upper()).lower()
    n = re.sub(r"(?<=[a-z]) (?=\d)", "", " ".join(n.split()))  # "usj 7" == "usj7"
    return n.replace("tasek", "tasik")


def dedupe(lines: Iterable[LineString]) -> MultiLineString:
    """Greedy: keep longest pieces first, drop anything already covered (double track, reverse dirs).
    Leftover pieces are re-attached to what's kept so junctions don't show gaps."""
    merged = linemerge(unary_union(list(lines)))
    parts = sorted(getattr(merged, "geoms", [merged]), key=lambda g: -g.length)
    kept: list[LineString] = []
    for p in parts:
        base = unary_union(kept) if kept else None
        rest = p if base is None else p.difference(base.buffer(DEDUPE))
        for r in getattr(rest, "geoms", [rest]):
            if not isinstance(r, LineString) or r.length <= DEDUPE:
                continue
            cs = list(r.coords)
            if base is not None:
                for i in (0, -1):
                    end = Point(cs[i])
                    if base.distance(end) < DEDUPE * 1.5:
                        q = nearest_points(base, end)[0].coords[0]
                        cs = [q, *cs] if i == 0 else [*cs, q]
            kept.append(LineString(cs))
    out = linemerge(kept)
    return out if isinstance(out, MultiLineString) else MultiLineString([out])


def to_coords(g: MultiLineString) -> Coords:
    s = g.simplify(SIMPLIFY)
    return [[[round(x, 5), round(y, 5)] for x, y in p.coords] for p in getattr(s, "geoms", [s]) if len(p.coords) > 1]


# ---------- OSM extract ----------

def osm() -> tuple[dict[str, dict], list[str]]:
    """Returns ({'w123': feature, 'n45': feature}, relation OPL lines)."""
    if not CACHE_PBF.exists():
        subprocess.run(["osmium", "tags-filter", "-O", "-o", CACHE_PBF, PBF,
                        "w/railway=rail", "w/route=ferry", "n/amenity=ferry_terminal", "r/route=train,ferry,subway,light_rail,monorail"], check=True)
    if not CACHE_GEO.exists():
        subprocess.run(["osmium", "export", "-O", "-f", "geojsonseq", "-u", "type_id",
                        "--geometry-types=linestring,point", "-o", CACHE_GEO, CACHE_PBF], check=True)
    feats = {}
    for l in open(CACHE_GEO, encoding="utf-8"):
        f = json.loads(l.lstrip("\x1e"))
        feats[f["id"]] = f
    rels = subprocess.run(["osmium", "cat", "-f", "opl", "-t", "relation", CACHE_PBF],
                          capture_output=True, text=True, check=True).stdout.splitlines()
    return feats, rels


def opl_members(rel_line: str) -> list[tuple[str, str]]:
    """'r1 ... Mn5@stop,w7@' → [('n5','stop'), ('w7','')]"""
    m = next(p for p in rel_line.split(" ") if p.startswith("M"))[1:]
    unesc = lambda s: re.sub(r"%([0-9a-f]+)%", lambda x: chr(int(x.group(1), 16)), s)
    return [(ref, unesc(role)) for ref, role in (x.split("@", 1) for x in m.split(",") if x)]


def relation_ways(feats: dict[str, dict], rel: str) -> list[LineString]:
    """Track geometry of a route relation (skips stop / platform members)."""
    return [LineString(feats[r]["geometry"]["coordinates"]) for r, role in opl_members(rel)
            if r[0] == "w" and r in feats and not role.startswith(("stop", "platform"))
            and feats[r]["geometry"]["type"] == "LineString"]


def rel_tags(rel: str) -> dict[str, str]:
    t = next((p for p in rel.split(" ") if p.startswith("T")), "T")[1:]
    unesc = lambda v: re.sub(r"%([0-9a-f]+)%", lambda x: chr(int(x.group(1), 16)), v)
    return {k: unesc(v) for k, v in (kv.split("=", 1) for kv in t.split(",") if "=" in kv)}


def chaikin(cs: list[tuple[float, float]], n: int = 2) -> list[tuple[float, float]]:
    """Corner-cutting smoothing; keeps both endpoints."""
    for _ in range(n):
        out = [cs[0]]
        for (x0, y0), (x1, y1) in zip(cs, cs[1:]):
            out += [(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1), (0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)]
        cs = [*out, cs[-1]]
    return cs


# ---------- Rapid Rail KL (OSM track, GTFS fallback) ----------

# OSM relation ref (network Rapid KL / RapidRail) → GTFS route_id
OSM_RAPID_REF = {"AG": "AG", "KJ": "KJ", "SP": "PH", "9": "KGL", "12": "PYL", "MR": "MR", "11": "SA"}

RAPID_MODE = {"AG": "lrt", "KJ": "lrt", "PH": "lrt", "SA": "lrt", "KGL": "mrt", "PYL": "mrt", "MR": "monorail", "BRT": "brt"}


def stop_lines(feed: Path, route_ok: set[str]) -> tuple[dict[str, set[str]], list[list[str]], dict[str, str]]:
    """stop_id → route_ids, plus distinct stop sequences per route (for KTM routing)."""
    trip_route = {t["trip_id"]: t["route_id"] for t in read_csv(feed / "trips.txt") if t["route_id"] in route_ok}
    seqs: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for st in read_csv(feed / "stop_times.txt"):
        if st["trip_id"] in trip_route:
            seqs[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))
    members: dict[str, set[str]] = defaultdict(set)
    patterns: dict[tuple[str, ...], str] = {}
    for trip, s in seqs.items():
        ids = tuple(sid for _, sid in sorted(s))
        patterns[ids] = trip_route[trip]
        for sid in ids:
            members[sid].add(trip_route[trip])
    return members, [[r, *p] for p, r in patterns.items()], trip_route


def rapid(feats: dict[str, dict], rels: list[str]) -> tuple[list[Line], list[dict], dict[str, str]]:
    ensure_feed(RAIL)
    routes = {r["route_id"]: r for r in read_csv(RAIL / "routes.txt")}
    shape_of = {t["route_id"]: t["shape_id"] for t in read_csv(RAIL / "trips.txt") if t["direction_id"] == "0"}
    pts: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for p in read_csv(RAIL / "shapes.txt"):
        pts[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lon"]), float(p["shape_pt_lat"])))
    osm_ways: dict[str, list[LineString]] = defaultdict(list)
    for rel in rels:
        t = rel_tags(rel)
        rid = OSM_RAPID_REF.get(t.get("ref", ""))
        if rid and t.get("route") in ("subway", "light_rail", "monorail") and "rapid" in t.get("network", "").lower():
            osm_ways[rid] += relation_ways(feats, rel)  # both directions; dedupe collapses them
    lines, source = [], {}
    for rid, r in routes.items():
        if rid not in RAPID_MODE:
            continue
        if osm_ways[rid]:
            geom, source[rid] = dedupe(osm_ways[rid]), "osm"
        else:  # GTFS shape is coarse (≤1.4 km segments): round off the corners
            cs = chaikin([(x, y) for _, x, y in sorted(pts[shape_of[rid]])])
            geom, source[rid] = MultiLineString([cs]), "gtfs"
        lines.append(Line(rid, r["route_long_name"], r["route_short_name"], RAPID_MODE[rid],
                          "#" + r["route_color"].upper(), geom))
    members, _, _ = stop_lines(RAIL, set(RAPID_MODE))
    stations = [{"name": nice(s["stop_name"]), "lng": float(s["stop_lon"]), "lat": float(s["stop_lat"]),
                 "lines": sorted(members[s["stop_id"]])} for s in read_csv(RAIL / "stops.txt") if members[s["stop_id"]]]
    return lines, stations, source


# ---------- KTM (GTFS stops, routed along OSM metre-gauge track) ----------

KTM_LINES = {  # route_id → (name, short, mode)
    "KC05_KB18": ("KTM Komuter Seremban Line", "SRL", "komuter"),
    "KA15_KD19": ("KTM Komuter Port Klang Line", "PKL", "komuter"),
    "100_47300": ("KTM Komuter Utara (Butterworth–Padang Besar)", "PBL", "komuter"),
    "100_9000": ("KTM Komuter Utara (Butterworth–Ipoh)", "IPL", "komuter"),
    "SS": ("KTM Komuter Shuttle Selatan", "SS", "komuter"),
    "ETS": ("KTM ETS", "ETS", "ets"),
}
SERVICE_COST = {"yard": 5.0, "siding": 5.0, "spur": 5.0, "crossover": 1.5}

Node = tuple[float, float]


class RailGraph:
    def __init__(self, feats: dict[str, dict]):
        self.adj: dict[Node, list[tuple[Node, float]]] = defaultdict(list)
        main: set[Node] = set()
        for f in feats.values():
            p = f["properties"]
            if f["geometry"]["type"] != "LineString" or p.get("railway") != "rail" or p.get("gauge") == "1435":
                continue  # standard gauge = ERL / MRT depots, not KTM track
            cost = SERVICE_COST.get(p.get("service", ""), 1.0)
            cs = [tuple(c) for c in f["geometry"]["coordinates"]]
            for a, b in zip(cs, cs[1:]):
                d = metres(a, b) * cost
                self.adj[a].append((b, d))
                self.adj[b].append((a, d))
            if "service" not in p:
                main.update(cs)
        # snap only onto big connected networks, not orphan fragments of track
        comp: dict[Node, int] = {}
        for n in main:
            if n in comp:
                continue
            seen, stack = {n}, [n]
            while stack:
                for v, _ in self.adj[stack.pop()]:
                    if v not in seen:
                        seen.add(v)
                        stack.append(v)
            for v in seen:
                comp[v] = len(seen)
        self.nodes = [n for n in main if comp[n] > 500]
        self.tree = STRtree([Point(n) for n in self.nodes])
        self.cache: dict[tuple[Node, Node], list[Node]] = {}

    def snap(self, lng: float, lat: float) -> Node | None:
        n = self.nodes[int(self.tree.nearest(Point(lng, lat)))]
        return n if metres(n, (lng, lat)) < 1000 else None

    def path(self, a: Node, b: Node) -> list[Node]:
        """A* shortest path over track; heuristic = straight-line metres."""
        key = (a, b) if a < b else (b, a)
        if key in self.cache:
            return self.cache[key]
        s, t = key
        dist, prev, pq = {s: 0.0}, {}, [(metres(s, t), 0.0, s)]
        while pq:
            _, d, u = heapq.heappop(pq)
            if u == t:
                break
            if d > dist[u]:
                continue
            for v, w in self.adj[u]:
                nd = d + w
                if nd < dist.get(v, math.inf):
                    dist[v], prev[v] = nd, u
                    heapq.heappush(pq, (nd + metres(v, t), nd, v))
        out = [t] if t in dist else []
        while out and out[-1] != s:
            out.append(prev[out[-1]])
        self.cache[key] = out
        return out


def ktm(feats: dict[str, dict]) -> tuple[list[Line], list[dict], list[str]]:
    ensure_feed(KTM)
    routes = {r["route_id"]: r for r in read_csv(KTM / "routes.txt")}
    stops = {s["stop_id"]: s for s in read_csv(KTM / "stops.txt")}
    members, patterns, _ = stop_lines(KTM, set(KTM_LINES))
    g = RailGraph(feats)
    stops = {k: s for k, s in stops.items() if float(s["stop_lat"]) < 6.75}  # drop Hat Yai (TH)
    members = {k: v for k, v in members.items() if k in stops}
    patterns = [[p[0], *(x for x in p[1:] if x in stops)] for p in patterns]
    snapped = {sid: g.snap(float(s["stop_lon"]), float(s["stop_lat"])) for sid, s in stops.items() if sid in members}
    segs: dict[str, list[LineString]] = defaultdict(list)
    gaps: list[str] = []
    for rid, *seq in patterns:
        for a, b in zip(seq, seq[1:]):
            na, nb = snapped.get(a), snapped.get(b)
            p = g.path(na, nb) if na and nb and na != nb else []
            if len(p) > 1:
                segs[rid].append(LineString(p))
            elif na != nb:  # no track found: fall back to a straight hop, and flag it
                segs[rid].append(LineString([(float(stops[x]["stop_lon"]), float(stops[x]["stop_lat"])) for x in (a, b)]))
                gaps.append(f"{rid}: {stops[a]['stop_name']} → {stops[b]['stop_name']}")
    lines = [Line(rid, name, short, mode, "#" + routes[rid]["route_color"].upper(), dedupe(segs[rid]))
             for rid, (name, short, mode) in KTM_LINES.items() if segs[rid]]
    stations = [{"name": nice(stops[sid]["stop_name"]), "lng": float(stops[sid]["stop_lon"]),
                 "lat": float(stops[sid]["stop_lat"]), "lines": sorted(r)} for sid, r in members.items()]
    return lines, stations, sorted(set(gaps))


# ---------- KLIA Ekspres / Transit (OSM relations) ----------

AIRPORT = {  # relation id → line
    "r8119878": ("KE", "KLIA Ekspres", "KLIA-E", "#800080"),
    "r8119876": ("KT", "KLIA Transit", "KLIA-T", "#139593"),
}

ERL_NAMES = {"KL Sentral Departure": "KL Sentral", "ERL Putrajaya/Cyberjaya": "Putrajaya Sentral"}


def airport(feats: dict[str, dict], rels: list[str]) -> tuple[list[Line], list[dict]]:
    lines, stations = [], []
    for rel in rels:
        rid = rel.split(" ", 1)[0]
        if rid not in AIRPORT:
            continue
        lid, name, short, color = AIRPORT[rid]
        mem = opl_members(rel)
        lines.append(Line(lid, name, short, "airport", color, dedupe(relation_ways(feats, rel))))
        for r, role in mem:
            f = feats.get(r)
            if r[0] == "n" and role.startswith("stop") and f and f["properties"].get("name"):
                x, y = f["geometry"]["coordinates"]
                n = re.sub(r"\s*\((ERL|KLIA Transit|KLIA Ekspres)\)", "", f["properties"]["name"])
                n = ERL_NAMES.get(n, n)
                stations.append({"name": n, "lng": x, "lat": y, "lines": [lid]})
    return lines, stations


# ---------- Ferries (OSM route=ferry ways, MY domestic only) ----------

Terminal = tuple[str, float, float]  # name, approx lng, lat (nearest way end gets the name)
FERRIES: list[tuple[str, str, str, Terminal, Terminal]] = [  # id, display name, OSM name:en regex, terminals
    ("PGF", "Penang Ferry", r"^Penang Ferry \(George Town",
     ("Pangkalan Raja Tun Uda", 100.344, 5.413), ("Pangkalan Sultan Abdul Halim", 100.364, 5.395)),
    ("LGK-KK", "Langkawi – Kuala Kedah", r"^Kuah Jetty - Kuala Kedah", ("Kuah Jetty", 99.849, 6.306), ("Kuala Kedah Jetty", 100.29, 6.107)),
    ("LGK-KP", "Langkawi – Kuala Perlis", r"^Kuah Jetty - Kuala Perlis", ("Kuah Jetty", 99.849, 6.306), ("Kuala Perlis Jetty", 100.127, 6.398)),
    ("PKR", "Lumut – Pangkor", r"^Lumut Jetty - Pangkor", ("Lumut Jetty", 100.632, 4.237), ("Pangkor Jetty", 100.577, 4.213)),
    ("KTM-I", "Port Klang – Pulau Ketam", r"^Port Klang - Ketam", ("Port Klang Jetty", 101.391, 2.999), ("Pulau Ketam Jetty", 101.253, 3.017)),
    ("TIO-M", "Mersing – Tioman", r"^Mersing - Tioman", ("Mersing Jetty", 103.839, 2.434), ("Tekek Jetty", 104.157, 2.82)),
    ("TIO-G", "Tanjung Gemok – Tioman", r"^Gemok Ferry Terminal - Tioman", ("Tanjung Gemok Ferry Terminal", 103.62, 2.66), ("Genting Jetty", 104.12, 2.76)),
    ("PHT", "Kuala Besut – Perhentian", r"^Kuala Besut - Perhentians", ("Kuala Besut Jetty", 102.558, 5.83), ("Perhentian Islands", 102.715, 5.9)),
    ("LBN-M", "Labuan – Menumbok", r"^Labuan - Menumbok", ("Labuan Ferry Terminal", 115.24, 5.277), ("Menumbok Jetty", 115.375, 5.303)),
    ("LBN-KK", "Kota Kinabalu – Labuan", r"^Kota Kinabalu To Labuan", ("Jesselton Point", 116.078, 5.991), ("Labuan Ferry Terminal", 115.24, 5.277)),
]
FERRY_COLOR = "#0A7CC1"


def ferries(feats: dict[str, dict]) -> tuple[list[Line], list[dict]]:
    lines, stations = [], []
    ways = [f for f in feats.values() if f["properties"].get("route") == "ferry" and f["geometry"]["type"] == "LineString"]
    for fid, name, pat, *terms in FERRIES:
        hits = [f for f in ways if re.search(pat, f["properties"].get("name:en") or f["properties"].get("name", ""))]
        if not hits:
            continue
        g = max((LineString(f["geometry"]["coordinates"]) for f in hits), key=lambda l: l.length)  # one direction only
        lines.append(Line(fid, name, fid, "ferry", FERRY_COLOR, MultiLineString([g])))
        for t, tx, ty in terms:
            x, y = min((g.coords[0], g.coords[-1]), key=lambda c: metres(c, (tx, ty)))
            stations.append({"name": t, "lng": x, "lat": y, "lines": [fid]})
    return lines, stations


# Kuching's penambang: small boats across the Sarawak River. Unnamed ferry ways along the waterfront, one line
PENAMBANG_BOX = (110.30, 1.54, 110.40, 1.58)  # w, s, e, n


def penambang(feats: dict[str, dict]) -> tuple[list[Line], list[dict]]:
    w, s, e, n = PENAMBANG_BOX
    inside = lambda c: w <= c[0] <= e and s <= c[1] <= n
    ways = [LineString(f["geometry"]["coordinates"]) for f in feats.values()
            if f["properties"].get("route") == "ferry" and not f["properties"].get("name")
            and f["geometry"]["type"] == "LineString" and all(map(inside, f["geometry"]["coordinates"]))]
    if not ways:
        return [], []
    merged = linemerge(ways)
    geom = merged if isinstance(merged, MultiLineString) else MultiLineString([merged])
    # Jetties on the crossings (within ~120 m of a boat line)
    stations = [{"name": nice(f["properties"].get("name:en") or f["properties"]["name"]), "lng": x, "lat": y, "lines": ["PNB"]}
                for f in feats.values() if f["properties"].get("amenity") == "ferry_terminal" and f["properties"].get("name")
                and f["geometry"]["type"] == "Point" and inside(c := f["geometry"]["coordinates"])
                and geom.distance(Point(c)) < 0.0011 for x, y in [c]]
    return [Line("PNB", "Penambang (Sarawak River)", "PNB", "ferry", FERRY_COLOR, geom)], stations


# ---------- stations: merge interchanges ----------

MODE_RANK = ["mrt", "lrt", "monorail", "brt", "airport", "komuter", "ets", "ferry"]


def merge_stations(raw: list[dict], mode_of: dict[str, str]) -> list[dict]:
    parent = list(range(len(raw)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_name: dict[str, list[int]] = defaultdict(list)
    for i, s in enumerate(raw):
        by_name[norm(s["name"])].append(i)
    for idx in by_name.values():
        for i in idx:
            for j in idx:
                if i < j and metres((raw[i]["lng"], raw[i]["lat"]), (raw[j]["lng"], raw[j]["lat"])) < MERGE_M:
                    parent[find(j)] = find(i)
    groups: dict[int, list[dict]] = defaultdict(list)
    for i, s in enumerate(raw):
        groups[find(i)].append(s)
    out = []
    for g in groups.values():
        lines = sorted({l for s in g for l in s["lines"]}, key=lambda l: (MODE_RANK.index(mode_of[l]), l))
        # display name from the most "urban" member (Rapid spelling beats KTM abbreviations)
        best = min(g, key=lambda s: min(MODE_RANK.index(mode_of[l]) for l in s["lines"]))
        out.append({"name": best["name"],
                    "lng": round(sum(s["lng"] for s in g) / len(g), 5),
                    "lat": round(sum(s["lat"] for s in g) / len(g), 5),
                    "lines": lines, "mode": mode_of[lines[0]]})
    return sorted(out, key=lambda s: s["name"])


# ---------- Shared track → parallel lanes ----------

SHARE = 0.0004  # deg ≈ 45 m: lines this close run on the same corridor
STEP = 0.0004   # sample spacing along a line


def lanes(lines: list[Line]) -> list[list[dict]]:
    """Split each line where the set of lines sharing its track changes. Each piece gets a lane
    (slot of n) so the frontend can draw shared corridors side by side. ETS is dropped wherever
    another line already draws the track (it only shows on intercity-only stretches)."""
    rail = [l for l in lines if l.mode != "ferry"]
    order = {l.id: i for i, l in enumerate(rail)}
    zones = {l.id: l.geom.buffer(SHARE) for l in rail}
    for z in zones.values():
        shapely.prepare(z)
    out = []
    for l in lines:
        if l.mode == "ferry":
            out.append([{"c": c, "s": 0, "n": 1} for c in to_coords(l.geom)])
            continue
        others = [o for o in rail if o.id != l.id and o.mode != "ets"]  # ETS never takes a lane
        pieces = []
        for part in l.geom.geoms:
            pts = shapely.get_coordinates(shapely.segmentize(part, STEP))
            share = [frozenset(o.id for o in others if shapely.contains_xy(zones[o.id], x, y)) for x, y in pts]
            # Smooth blips (crossings, short brushes) into the run before them
            runs: list[list[int]] = []
            for i, sh in enumerate(share):
                if runs and share[runs[-1][0]] == sh:
                    runs[-1].append(i)
                else:
                    runs.append([i])
            for k in range(1, len(runs)):
                if len(runs[k]) < 4:
                    for i in runs[k]:
                        share[i] = share[runs[k - 1][0]]
            start = 0
            for i in range(1, len(pts) + 1):
                if i == len(pts) or share[i] != share[start]:
                    seg, sh = pts[start:i + 1], share[start]
                    start = i
                    if len(seg) < 2 or (l.mode == "ets" and sh):
                        continue
                    group = sorted(sh | {l.id}, key=order.__getitem__)
                    # One direction per corridor so lane offsets land on the same side for every line
                    dx, dy = seg[-1][0] - seg[0][0], seg[-1][1] - seg[0][1]
                    if (dy if abs(dx) < abs(dy) * 0.1 else dx) < 0:
                        seg = seg[::-1]
                    for c in to_coords(MultiLineString([LineString(seg)])):
                        pieces.append({"c": c, "s": group.index(l.id), "n": len(group)})
        out.append(pieces)
    return out


def main() -> None:
    feats, rels = osm()
    r_lines, r_st, source = rapid(feats, rels)
    k_lines, k_st, gaps = ktm(feats)
    a_lines, a_st = airport(feats, rels)
    f_lines, f_st = ferries(feats)
    p_lines, p_st = penambang(feats)
    f_lines, f_st = f_lines + p_lines, f_st + p_st
    lines = r_lines + a_lines + k_lines + f_lines
    mode_of = {l.id: l.mode for l in lines}
    stations = merge_stations(r_st + k_st + a_st + f_st, mode_of)
    data = {
        "lines": [{"id": l.id, "name": l.name, "short": l.short, "mode": l.mode, "color": l.color, "pieces": p}
                  for l, p in zip(lines, lanes(lines))],
        "stations": stations,
    }
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    for l in data["lines"]:
        cs = [c for p in l["pieces"] for c in p["c"]]
        seg = max((metres(a, b) for p in l["pieces"] for a, b in zip(p["c"], p["c"][1:])), default=0)
        print(f"{l['id']:10} {l['mode']:8} {source.get(l['id'], 'osm'):4} pts={len(cs):5} maxseg={seg:5.0f}m "
              f"pieces={len(l['pieces']):3} max n={max((p['n'] for p in l['pieces']), default=0)}  {l['name']}")
    print(f"{len(stations)} stations, {OUT.stat().st_size / 1024:.0f} KB → {OUT.relative_to(ROOT)}")
    for gap in gaps:
        print("  straight-line fallback:", gap)


if __name__ == "__main__":
    main()
