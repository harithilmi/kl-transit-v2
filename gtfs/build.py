"""GTFS static (data.gov.my) → compact per-region JSON for the web app.

Run: python3 gtfs/build.py   (reads gtfs/raw/<feed>/, writes data/)
"""
from __future__ import annotations

import csv, hashlib, os, json, math, re, sys, urllib.error, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from shapely import LineString, MultiPoint, Point
from shapely.affinity import scale

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "gtfs" / "raw"
OUT = ROOT / "data"

# feed dir → (operator name, brand colour)
OPERATORS = {
    "prasarana-rapid-bus-kl": ("Rapid KL", "#1363b8"),
    "prasarana-rapid-bus-mrtfeeder": ("Rapid KL", "#1e8c45"),  # riders see the Rapid KL brand
    "prasarana-rapid-bus-penang": ("Rapid Penang", "#d7282f"),
    "mybas-johor": ("BAS.MY Johor Bahru", "#e0338f"),
    "mybas-melaka": ("BAS.MY Melaka", "#e0338f"),
    "mybas-ipoh": ("BAS.MY Ipoh", "#e0338f"),
    "mybas-seremban-a": ("BAS.MY Seremban", "#e0338f"),  # A/B are just two contract holders
    "mybas-seremban-b": ("BAS.MY Seremban", "#e0338f"),
    "mybas-kangar": ("BAS.MY Kangar", "#e0338f"),
    "mybas-alor-setar": ("BAS.MY Alor Setar", "#e0338f"),
    "mybas-kota-bharu": ("BAS.MY Kota Bharu", "#e0338f"),
    "mybas-kuala-terengganu": ("BAS.MY Kuala Terengganu", "#e0338f"),
    "mybas-kuching": ("BAS.MY Kuching", "#e0338f"),
}

REGIONS = [
    ("klang-valley", "Klang Valley", ["prasarana-rapid-bus-kl", "prasarana-rapid-bus-mrtfeeder"]),
    ("penang", "Penang", ["prasarana-rapid-bus-penang"]),
    ("johor-bahru", "Johor Bahru", ["mybas-johor"]),
    ("melaka", "Melaka", ["mybas-melaka"]),
    ("seremban", "Seremban", ["mybas-seremban-a", "mybas-seremban-b"]),
    ("ipoh", "Ipoh", ["mybas-ipoh"]),
    ("kangar", "Kangar", ["mybas-kangar"]),
    ("alor-setar", "Alor Setar", ["mybas-alor-setar"]),
    ("kota-bharu", "Kota Bharu", ["mybas-kota-bharu"]),
    ("kuala-terengganu", "Kuala Terengganu", ["mybas-kuala-terengganu"]),
    ("kuching", "Kuching", ["mybas-kuching"]),
]

MERGE_M = 30  # same-name stops closer than this become one stop

# Feeds whose shapes are just stop-to-stop straight lines get routed on real roads
VALHALLA = "http://localhost:8004"
SNAP_CACHE = ROOT / "gtfs" / "snap-cache.json"
snap_cache: dict[str, list] = json.loads(SNAP_CACHE.read_text()) if SNAP_CACHE.exists() else {}

# Kept upper-case when title-casing ALL-CAPS names
ACRONYMS = set("""BRT MRT LRT KTM KL KLCC KLIA KLIA2 PJ SS USJ TTDI HKL UKM UM UIA UITM USIM UPM UNITEN
SK SMK SJK SJKC SJKT SRK SMA PPR PPA IPD IPK JKR TNB TM LHDN KWSP PKNS PKNP MPAJ MBPJ DBKL MBSA MPS
AEON KPJ HSA JB KSL IOI MITC PD KK ICC ATM KFC UTC PPUM RTM MAHSA KTMB LPT
IKEA CIQ BSI MBKT KSL JPJ HUKM UTM UTHM KPT BSN UTEM CIMB RHB HSBC OCBC UOB JKM PDRM UIAM IPG ILP KPM PKNJ MRSM SOGO UTAR LTSAS"""
.split())


def read(feed: str, name: str):
    path = RAW / feed / f"{name}.txt"
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(f)]


def secs(t: str) -> int:
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def hhmm(s: int) -> str:
    return f"{s // 3600 % 24:02d}{s // 60 % 60:02d}"


def smart_title(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    letters = [c for c in s if c.isalpha()]
    if not letters or sum(c.isupper() for c in letters) / len(letters) < 0.6:
        return s  # already mixed case

    def word(w: str) -> str:
        core = re.sub(r"[^A-Za-z0-9]", "", w)
        if core.upper() in ACRONYMS or (any(c.isdigit() for c in w) and len(core) <= 6) or not w.isupper():
            return w
        return re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), w.lower())

    return " ".join(word(w) for w in s.split(" "))


def tidy(name: str) -> str:
    """Rider-friendly cleanup shared by stop and route names."""
    name = re.sub(r"^\([A-Z]\d*\)\s*", "", name)  # "(M1) Hub …" → "Hub …"
    name = re.sub(r"\bStesen (?=(LRT|MRT|BRT|KTM|Monorel)\b)", "", name)  # "Stesen MRT X" → "MRT X"
    name = re.sub(r"([a-z]{3,})(\d)", r"\1 \2", name)  # "Terminal1" → "Terminal 1"
    name = re.sub(r"\bVia\b", "via", name)
    name = re.sub(r"\bhab\b", "HAB", name, flags=re.I)  # Hentian Akhir Bandar, an acronym
    name = re.sub(r"\b[A-Z]{4,}\b", lambda m: m[0] if m[0] in ACRONYMS else m[0].capitalize(), name)  # "PORT" → "Port"
    return re.sub(r"\s+", " ", name).strip()


def dist_m(a, b) -> float:
    dx = (a[0] - b[0]) * 111320 * math.cos(math.radians(a[1]))
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


def simplify(pts, tol=0.00002):
    """Douglas-Peucker in degrees (~2 m)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        n = math.hypot(dx, dy)
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x0, y0 = pts[k]
            # Loops start and end on the same point: fall back to distance from it
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / n if n > 1e-12 else math.hypot(x0 - x1, y0 - y1)
            if d > best:
                best, idx = d, k
        if best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def encode(pts) -> str:
    """Google encoded polyline, precision 5, [lng, lat] input."""
    out, plat, plng = [], 0, 0
    for lng, lat in pts:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for v in (ilat - plat, ilng - plng):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


def service_number(r) -> str:
    short, long, rid = r.get("route_short_name", ""), r.get("route_long_name", ""), r["route_id"]
    for c in (short, long):
        if c and len(c) <= 6:
            return c
    if short and short != long:
        if short.upper() == "SUNWAY LINE":
            return "BRT"
        if m := re.search(r"\(([A-Z0-9]{2,6})\)", short):  # "PAVILION BUKIT JALIL (PAVBJ)"
            return m[1]
        return "".join(w[0] for w in short.split())[:4].upper()  # initials
    return rid


def active_services(feed: str) -> set[str] | None:
    """Service ids running on a typical weekday; None = count everything."""
    cal = read(feed, "calendar")
    ids = {c["service_id"] for c in cal if c.get("wednesday") == "1"}
    return ids or None


class StopIndex:
    """Region-wide stops; merges same-name stops within MERGE_M (per-route duplicates, shared feeds)."""

    def __init__(self):
        self.stops: list[list] = []
        self.grid: dict[tuple, list[int]] = defaultdict(list)

    def add(self, lng: float, lat: float, name: str, code: str) -> int:
        key = name.lower()
        gx, gy = int(lng / 0.0005), int(lat / 0.0005)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.grid[(gx + dx, gy + dy)]:
                    s = self.stops[i]
                    if s[2].lower() == key and dist_m((lng, lat), (s[0], s[1])) < MERGE_M:
                        if code and not s[3]:
                            s[3] = code
                        return i
        self.stops.append([round(lng, 5), round(lat, 5), name, code])
        self.grid[(gx, gy)].append(len(self.stops) - 1)
        return len(self.stops) - 1


def build_feed(feed: str, op_idx: int, stops: StopIndex):
    stop_map = {}
    raw_stops = read(feed, "stops")
    codes = Counter(s.get("stop_code", "") for s in raw_stops)
    codes_ok = sum(n for c, n in codes.items() if c and n > 1) < 0.05 * len(raw_stops)
    for s in raw_stops:
        if s.get("location_type", "0") not in ("", "0"):
            continue
        try:
            lat, lng = float(s["stop_lat"]), float(s["stop_lon"])
        except ValueError:
            continue
        code = s.get("stop_code", "") if codes_ok else ""
        if code.upper().startswith("DUMMY"):  # placeholder codes in the feed, not on any pole
            code = ""
        name = re.sub(r"^\([A-Z]\d*\)\s*", "", s["stop_name"])  # "(M) KL2147 …" → "KL2147 …"
        # Rapid KL puts the stop code in the name: "KL1821 Pasar Seni"
        if m := re.fullmatch(r"([A-Z]{1,3}\d{2,5})\s+(.+)", name):
            code, name = code or m[1], m[2]
        # "Stesen MRT Semantan" → "MRT Semantan"
        name = tidy(smart_title(name))
        stop_map[s["stop_id"]] = stops.add(lng, lat, name, code)

    routes = {r["route_id"]: r for r in read(feed, "routes")}
    trips = {t["trip_id"]: t for t in read(feed, "trips")}
    if not routes or not trips:
        return []

    freq = defaultdict(list)
    for f in read(feed, "frequencies"):
        freq[f["trip_id"]].append((secs(f["start_time"]), secs(f["end_time"]), int(f["headway_secs"])))

    times = defaultdict(list)
    with open(RAW / feed / "stop_times.txt", newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            if row["trip_id"] in trips and row["stop_id"] in stop_map:
                t = row["departure_time"] or row["arrival_time"]
                times[row["trip_id"]].append((int(row["stop_sequence"]), stop_map[row["stop_id"]], secs(t) if t else None))

    active = active_services(feed)
    # (route, direction) → pattern key → trips
    groups: dict[tuple, dict[tuple, list[str]]] = defaultdict(lambda: defaultdict(list))
    for tid, st in times.items():
        st.sort()
        seq = tuple(s for _, s, _ in st)
        # Consecutive duplicates (merged stops) collapse
        seq = tuple(s for i, s in enumerate(seq) if i == 0 or s != seq[i - 1])
        if len(seq) < 2:
            continue
        t = trips[tid]
        groups[(t["route_id"], t.get("direction_id") or "0")][seq].append(tid)

    shape_ids = set()
    chosen = []  # (route_id, dir, seq, trip ids)
    for (rid, d), pats in groups.items():
        seq, tids = max(pats.items(), key=lambda kv: len(kv[1]))
        chosen.append((rid, d, seq, tids))
        shape_ids.update(trips[t].get("shape_id", "") for t in tids)

    shapes = defaultdict(list)
    with open(RAW / feed / "shapes.txt", newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            if row["shape_id"] in shape_ids:
                shapes[row["shape_id"]].append((int(float(row["shape_pt_sequence"])), float(row["shape_pt_lon"]), float(row["shape_pt_lat"])))

    services: dict[str, dict] = {}
    for rid, d, seq, tids in sorted(chosen, key=lambda c: (c[0], c[1])):
        r = routes.get(rid)
        if not r:
            continue
        run = [t for t in tids if active is None or trips[t]["service_id"] in active] or tids

        # Departures from the first stop, expanding frequency-based trips
        deps = []
        for t in run:
            if freq.get(t):
                for a, b, h in freq[t]:
                    deps += range(a, b + 1, h) if h else [a]
            else:
                first = next((x for _, _, x in times[t] if x is not None), None)
                if first is not None:
                    deps.append(first)
        deps.sort()

        # Minutes from first stop, from a trip with real per-stop times (some feeds repeat the start time)
        def span(t: str) -> int:
            xs = [x for _, _, x in times[t] if x is not None]
            return xs[-1] - xs[0] if len(xs) == len(times[t]) else -1

        rep = max(tids[:50], key=span)
        mins = None
        if span(rep) > 0:
            # Same consecutive-duplicate collapse as `seq`, so times line up by position (loops revisit the start)
            st = [(s, x) for i, (_, s, x) in enumerate(times[rep]) if i == 0 or s != times[rep][i - 1][1]]
            mins = [round((x - st[0][1]) / 60) for _, x in st]

        sid = Counter(trips[t].get("shape_id", "") for t in tids).most_common(1)[0][0]
        pts = [(x, y) for _, x, y in sorted(shapes.get(sid, []))]
        stop_pts = [(stops.stops[s][0], stops.stops[s][1]) for s in seq]
        # Feed bug guard: shape drawn for another route (e.g. KL HLB2) → most stops far from it
        stray = len(pts) >= 2 and sum(min(dist_m(p, q) for q in pts) > 400 for p in stop_pts) > len(seq) / 2
        if stray:
            pts = []
        if len(pts) < 2 * len(seq):  # too coarse to follow roads
            pts = road_path([(stops.stops[s][0], stops.stops[s][1]) for s in seq]) or pts
        else:  # dense but often GPS-noisy: snap the feed's own path onto the roads
            matched = match_shape(pts, stop_pts)
            if matched is None and os.environ.get("DEBUG"):
                print(f"  kept feed shape: {feed} {r.get('route_short_name') or r['route_id']}", file=sys.stderr)
            pts = matched or pts
        if len(pts) < 2:
            pts = [(stops.stops[s][0], stops.stops[s][1]) for s in seq]

        # "Towards" = last stop; loops name their turnaround
        loop = seq[0] == seq[-1] or dist_m(stops.stops[seq[0]], stops.stops[seq[-1]]) < 300
        pattern = {
            "to": turnaround(stops, seq) if loop else stops.stops[seq[-1]][2],
            "loop": loop,
            "stops": list(seq),
            "mins": mins,
            "shape": encode(simplify(pts)),
            "trips": len(deps),
            "first": hhmm(deps[0]) if deps else None,
            "last": hhmm(deps[-1]) if deps else None,
        }

        svc = services.get(rid)
        if not svc:
            no = service_number(r)
            long = smart_title(r.get("route_long_name", ""))
            if len(long) <= 6:  # just a number (Penang "401", feeder "T117") → derive from stops
                long = ""
            color = r.get("route_color", "")
            svc = services[rid] = {
                "id": rid,  # GTFS route_id: live bus positions name their route by it
                "no": no,
                "name": long,
                "op": op_idx,
                "color": f"#{color}" if re.fullmatch(r"[0-9A-Fa-f]{6}", color) and color.upper() not in ("FFFFFF", "FF40B4") else None,
                "patterns": [],
            }
        if stray:
            svc["name"] = ""  # the route name describes the wrong shape too
        svc["patterns"].append(pattern)

    out = []
    for svc in services.values():
        # Loop service: both directions identical → keep one
        if len(svc["patterns"]) == 2 and svc["patterns"][0]["stops"] == svc["patterns"][1]["stops"]:
            svc["patterns"].pop()
        # Route name: A ⇄ B (two ways) · A ⟲ B (loop) · A → B (one way).
        # Prefer the feed's own "A - B" route name (names areas, e.g. "Medan Kidd - Bercham via Taman Ipoh");
        # otherwise derive it from the end stops.
        p0 = svc["patterns"][0]
        sym = "⟲" if p0["loop"] else "⇄" if len(svc["patterns"]) == 2 else "→"
        parts = [tidy(x) for x in re.split(r"\s*[~–]\s*|\s*-\s+|\s+-\s*|(?<=[a-z0-9])-(?=[A-Z])", svc["name"]) if x.strip()]
        if p0["loop"]:
            parts = [re.sub(r"\s+Loop$", "", x, flags=re.I) for x in parts]
        if len(parts) >= 2:
            svc["name"] = f"{parts[0]} {sym} {' · '.join(parts[1:])}"
        else:
            first, last = stops.stops[p0["stops"][0]][2], stops.stops[p0["stops"][-1]][2]
            svc["name"] = f"{first} {sym} {p0['to'] if p0['loop'] else last}"
        out.append(svc)
    return out


def turnaround(stops: StopIndex, seq) -> str:
    """Farthest stop from the start: where an out-and-back route turns."""
    start = stops.stops[seq[0]]
    return max((stops.stops[i] for i in seq), key=lambda st: dist_m(start, st))[2]


def decode6(enc: str):
    """Valhalla polyline6 → [(lng, lat)]"""
    out, i, lat, lng = [], 0, 0, 0
    while i < len(enc):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(enc[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat, lng = lat + vals[0], lng + vals[1]
        out.append((lng / 1e6, lat / 1e6))
    return out


def valhalla(endpoint: str, body: dict):
    req = urllib.request.Request(f"{VALHALLA}/{endpoint}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return [p for leg in json.load(r)["trip"]["legs"] for p in decode6(leg["shape"])]


def length_km(pts) -> float:
    return sum(dist_m(a, b) for a, b in zip(pts, pts[1:])) / 1000


def bearing(a, b) -> int:
    lat1, lat2, dlng = math.radians(a[1]), math.radians(b[1]), math.radians(b[0] - a[0])
    y = math.sin(dlng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return round(math.degrees(math.atan2(y, x)) % 360)


def despike(pts, max_m=150):
    """Drop GPS blips: a point where the line doubles straight back (< 25°) over a short hop."""
    out = list(pts[:1])
    for b, c in zip(pts[1:], pts[2:]):
        a = out[-1]
        v1, v2 = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        n = math.hypot(*v1) * math.hypot(*v2)
        sharp = n and (v1[0] * v2[0] + v1[1] * v2[1]) / n > math.cos(math.radians(25))
        if not (sharp and min(dist_m(a, b), dist_m(b, c)) < max_m):
            out.append(b)
    return out + list(pts[-1:])


def drift(a: LineString, b: LineString, step_m=25, far_m=60) -> float:
    """Share of line a (sampled every step_m) lying more than far_m from line b."""
    n = max(2, int(a.length * 111000 / step_m))
    return sum(b.distance(a.interpolate(i / n, normalized=True)) * 111000 > far_m for i in range(n + 1)) / (n + 1)


def match_shape(pts, stop_pts):
    """The feed's own path, snapped onto real roads (Valhalla map-matching); cached.
    None when the match drifts (much longer/shorter, or stops end up off the line) → keep the feed's shape."""
    key = "m:" + hashlib.sha1(json.dumps(pts).encode()).hexdigest()
    if key in snap_cache:
        return [tuple(p) for p in snap_cache[key]] or None
    pts = despike(pts)
    path, ok = None, False
    for radius in (40, 80):  # tight first; wider for shapes drawn off the carriageway
        try:
            path = valhalla("trace_route", {
                "shape": [{"lon": x, "lat": y} for x, y in pts], "costing": "bus", "shape_match": "map_snap",
                "trace_options": {"search_radius": radius, "breakage_distance": 2000, "interpolation_distance": 10},
                "directions_type": "none"})
        except OSError as e:
            if not isinstance(e, urllib.error.HTTPError):
                return None  # server down → don't cache
            path = None
        except Exception:
            path = None
        if path and len(path) > 1:
            line, orig = LineString(path), LineString(pts)
            off = sum(line.distance(Point(p)) * 111000 > 60 for p in stop_pts)
            ok = (0.85 <= length_km(path) / max(length_km(pts), 0.01) <= 1.25 and off <= len(stop_pts) * 0.1
                  and drift(orig, line) <= 0.03 and drift(line, orig) <= 0.03)  # no skipped detours, no invented ones
        if ok:
            break
    snap_cache[key] = path if ok else []
    return path if ok else None


def road_path(stop_pts):
    """Road-following path through the stops, via Valhalla; cached. None if unavailable.

    Map-matching (trace_route) first: it optimises the whole trip, so stops that sit on the
    wrong side of a dual carriageway don't cause U-turn loops. Leg-by-leg routing with
    headings is the fallback.
    """
    key = hashlib.sha1(json.dumps(stop_pts).encode()).hexdigest()
    if key in snap_cache:
        return [tuple(p) for p in snap_cache[key]]
    direct = length_km(stop_pts)
    plausible = lambda path: path and 0.8 <= length_km(path) / max(direct, 0.01) <= 2

    path = None
    try:
        path = valhalla("trace_route", {
            "shape": [{"lon": x, "lat": y} for x, y in stop_pts], "costing": "bus", "shape_match": "map_snap",
            "trace_options": {"search_radius": 50, "breakage_distance": 3000, "interpolation_distance": 10},
            "directions_type": "none"})
    except OSError as e:
        if not isinstance(e, urllib.error.HTTPError):
            return None  # server down → keep the feed's own shape, don't cache
    except Exception:
        pass

    if not plausible(path):
        path, chunk = [], 20
        for start in range(0, len(stop_pts) - 1, chunk - 1):
            part = stop_pts[start:start + chunk]
            locs = [{"lon": x, "lat": y, "type": "break" if k in (0, len(part) - 1) else "through", "radius": 35,
                     "heading": bearing(part[max(k - 1, 0)], part[min(k + 1, len(part) - 1)]), "heading_tolerance": 60}
                    for k, (x, y) in enumerate(part)]
            try:
                seg = valhalla("route", {"locations": locs, "costing": "bus", "directions_type": "none"})
            except Exception:
                seg = list(part)  # unroutable chunk → straight lines
            path += seg[1:] if path else seg
        if not plausible(path):
            path = None  # still silly → keep the feed's shape

    snap_cache[key] = path or []
    return path


def service_area(pts, pad_m=2000):
    """Area a region's buses serve: one smooth outline round all its stops (convex hull, padded pad_m, rounded corners)."""
    lat0 = sum(y for _, y in pts) / len(pts)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540  # degrees → metres (local, flat)
    hull = MultiPoint([(x * kx, y * ky) for x, y in pts]).convex_hull.buffer(pad_m, quad_segs=12).simplify(50)
    ring = scale(hull, 1 / kx, 1 / ky, origin=(0, 0)).exterior
    return [[[[round(x, 5), round(y, 5)] for x, y in ring.coords]]]  # GeoJSON MultiPolygon coordinates




def natural(s: str):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def main():
    OUT.mkdir(exist_ok=True)
    index = []
    for rid, rname, feeds in REGIONS:
        stops = StopIndex()
        operators, services = [], []
        for feed in feeds:
            if not (RAW / feed / "stop_times.txt").exists():
                continue
            name, color = OPERATORS[feed]
            svcs = build_feed(feed, len(operators), stops)
            if svcs:
                operators.append({"id": feed, "name": name, "color": color})
                services += svcs
        if not services or len(stops.stops) < 5:
            print(f"skip {rid}: no usable data", file=sys.stderr)
            continue

        # Drop stops no pattern uses; re-index
        used = sorted({s for svc in services for p in svc["patterns"] for s in p["stops"]})
        remap = {old: new for new, old in enumerate(used)}
        stop_list = [stops.stops[i] for i in used]
        for svc in services:
            for p in svc["patterns"]:
                p["stops"] = [remap[s] for s in p["stops"]]
        services.sort(key=lambda s: (natural(s["no"]), s["op"]))

        lngs, lats = [s[0] for s in stop_list], [s[1] for s in stop_list]
        bounds = [min(lngs), min(lats), max(lngs), max(lats)]
        region = {"id": rid, "name": rname, "bounds": bounds, "operators": operators, "stops": stop_list, "services": services}
        path = OUT / f"{rid}.json"
        path.write_text(json.dumps(region, separators=(",", ":"), ensure_ascii=False))
        index.append({"id": rid, "name": rname, "bounds": bounds, "operators": list(dict.fromkeys(o["name"] for o in operators)),
                      "services": len(services), "stops": len(stop_list), "area": service_area([(s[0], s[1]) for s in stop_list])})
        print(f"{rid:14} {len(services):4} services {len(stop_list):5} stops {path.stat().st_size / 1024:7.0f} KB")

    SNAP_CACHE.write_text(json.dumps(snap_cache, separators=(",", ":")))
    (OUT / "regions.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
