# KL Transit

Bus routes and stops for every Malaysian city with open GTFS data, on one map, with rail and ferry lines for context.

Pick a city, tap a bus to see its route and stops, tap a stop to see every bus that passes it, or search for a place to find the stops nearby.

| City | Operator |
|---|---|
| Klang Valley | Rapid KL (incl. MRT feeder) |
| Penang | Rapid Penang |
| Johor Bahru · Melaka · Seremban · Ipoh · Kuala Terengganu · Kuching · Kota Bharu | BAS.MY |

Kangar and Alor Setar are wired up but their feeds are still empty.

## Features

- **Buses:** each route has its own colour and shows both directions, the "via" and the full stop list. Other buses and nearby rail (KJ, KG, KTM…) are listed at every stop.
- **Stops:** a stop lists every bus through it with how often it comes. Hover a bus to see its line, or show all passing routes at once.
- **Map:** stops are plain dots, with the code and name appearing as you zoom in. Taps are two-step: the first zooms in, the second opens.
- **Rail and ferry layer:** LRT, MRT, Monorail, BRT, KTM Komuter, KLIA lines, ETS, domestic ferries and the Kuching penambang. Shared track is drawn as parallel lanes. The layer is context only, not clickable.
- **Place search:** a local Nominatim instance searches places, and the results list stops within walking distance.
- **Cities:** each city's service area is outlined. Click another city's outline to switch to it.
- **Links:** every view has its own URL, e.g. `#/klang-valley/bus/T811` or `#/penang/stop/IHA1569`.

## How it works

```
data.gov.my GTFS ──► gtfs/build.py ──► data/<city>.json + data/regions.json
                        │  merge feeds per city, tidy names, pick one pattern per direction,
                        │  snap every shape to real roads (Valhalla map-matching, cached)
OSM + rail GTFS  ──► gtfs/transit.py ──► data/transit.json   (rail + ferry overlay)

index.html  ── MapLibre GL + plain JS, no build step ──► reads data/*.json
```

The app is a single static `index.html`. All heavy work happens once, in the Python build scripts.

## Run it

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

The built data is committed, so the app runs as-is. Place search also needs Nominatim (see below); without it, the rest of the app works and search says it's unavailable.

## Rebuild the data

Requirements:
- Python 3.9+ with `shapely` 2.x
- For the rail overlay: the `osmium` CLI
- For road snapping: a local Valhalla server

**1. Download the GTFS feeds** into `gtfs/raw/` (git-ignored):

```sh
cd gtfs/raw
for f in rapid-bus-kl rapid-bus-mrtfeeder rapid-bus-penang; do
  curl -L -o prasarana-$f.zip "https://api.data.gov.my/gtfs-static/prasarana?category=$f"
  mkdir -p prasarana-$f && unzip -o -q prasarana-$f.zip -d prasarana-$f
done
for f in johor melaka ipoh seremban-a seremban-b kangar alor-setar kota-bharu kuala-terengganu kuching; do
  curl -L -o mybas-$f.zip "https://api.data.gov.my/gtfs-static/mybas-$f"
  mkdir -p mybas-$f && unzip -o -q mybas-$f.zip -d mybas-$f
done
```

**2. Build:**

```sh
python3 gtfs/build.py     # buses → data/<city>.json, data/regions.json
python3 gtfs/transit.py   # rail + ferry → data/transit.json (downloads its own GTFS, needs the OSM PBF)
```

Road snapping calls Valhalla at `localhost:8004`. Results are cached in `gtfs/snap-cache.json`, so a rebuild with the cache takes about 15 s and doesn't need Valhalla at all. Matches that drift from the feed's own path (skipped or invented detours) are rejected, and the feed shape is kept.

## Local services

Both services use the Geofabrik extract `malaysia-singapore-brunei-latest.osm.pbf`, expected at `~/valhalla/malaysia/`.

| Service | Port | Used for |
|---|---|---|
| Valhalla | 8004 | Snapping bus shapes to roads (build time only) |
| Nominatim (`mediagis/nominatim:4.4`) | 8088 | Place search in the app |

Nominatim, first import takes a while:

```sh
docker run -d --name nominatim-my -p 8088:8080 \
  -v ~/valhalla/malaysia/malaysia-singapore-brunei-latest.osm.pbf:/pbf/malaysia.osm.pbf:ro \
  -e PBF_PATH=/pbf/malaysia.osm.pbf \
  -v nominatim-my-data:/var/lib/postgresql/14/main \
  mediagis/nominatim:4.4
```

## Project layout

```
index.html          the whole app (HTML, CSS, JS)
data/               built JSON the app loads (committed)
gtfs/build.py       bus GTFS → data/<city>.json
gtfs/transit.py     rail/ferry overlay → data/transit.json
gtfs/snap-cache.json   Valhalla results, keyed by input shape
gtfs/raw/           downloaded feeds (git-ignored)
```

## Data and credits

- **Bus and rail timetables:** [data.gov.my GTFS Static](https://developer.data.gov.my/realtime-api/gtfs-static) (Prasarana, BAS.MY, KTMB)
- **Map tiles:** [OpenFreeMap](https://openfreemap.org), with rail and ferry geometry and places from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- **Map rendering:** [MapLibre GL JS](https://maplibre.org)
- **Road snapping:** [Valhalla](https://github.com/valhalla/valhalla)
- **Place search:** [Nominatim](https://nominatim.org)

Timetable-based only: frequencies and first/last bus come from the static schedule, not live positions.
