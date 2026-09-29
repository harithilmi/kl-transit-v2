# KL Transit

KL Transit shows bus routes and bus stops for all Malaysian cities that have open GTFS data. It shows all these cities on one map. It also shows rail lines and ferry lines.

## Use the app

1. Select a city.
2. Select a bus to see its route and its stops.
3. Select a stop to see all the buses that stop there.
4. To find the stops near a place, type the name of the place in the search box.

## Cities

| City | Operator |
|---|---|
| Klang Valley | Rapid KL (with MRT feeder) |
| Penang | Rapid Penang |
| Johor Bahru · Melaka · Seremban · Ipoh · Kuala Terengganu · Kuching · Kota Bharu | BAS.MY |

The build script contains Kangar and Alor Setar. At this time, the feeds for these two cities contain no data.

## Functions

- **Buses:** Each route has its own color. The route shows the two directions, the "via" name, and all the stops. Each stop in the list shows the other buses and the rail lines near it (KJ, KG, KTM).
- **Stops:** A stop shows all the buses that stop there and the time between the buses. Put the pointer on a bus to see its line. To see all the lines, push "Show all passing routes".
- **Map:** A stop is a dot. When you zoom in, the map shows the stop code and the stop name. The first click on a stop zooms in. The second click opens the stop.
- **Rail and ferry layer:** The map shows the LRT, MRT, Monorail, BRT, KTM Komuter, KLIA lines, ETS, the domestic ferries, and the Kuching penambang boats. Where lines use the same track, the map shows them as parallel lines. This layer gives information only. A click on this layer does nothing.
- **Place search:** A local Nominatim server finds the places. The result shows the stops that are near the place.
- **Cities:** The map shows a line around the service area of each city. To change to a different city, click the line around that city.
- **Links:** Each view has its own URL, for example `#/klang-valley/bus/T811` or `#/penang/stop/IHA1569`.

## How the app works

```
data.gov.my GTFS ──► gtfs/build.py ──► data/<city>.json + data/regions.json
                        │  merge feeds per city, clean names, keep one pattern per direction,
                        │  snap each shape to roads (Valhalla map matching, cached)
OSM + rail GTFS  ──► gtfs/transit.py ──► data/transit.json   (rail + ferry layer)

index.html  ── MapLibre GL + plain JS, no build step ──► reads data/*.json
```

The app is one static file, `index.html`. The Python build scripts do all the large tasks one time before you use the app.

## Start the app

1. Start a web server in the project folder:

   ```sh
   python3 -m http.server 8765
   ```

2. Open `http://localhost:8765` in a browser.

The repository contains the built data. The app operates without a build. Place search uses Nominatim (refer to "Local services"). If Nominatim does not operate, place search shows a message. The other functions operate correctly.

## Build the data again

Before you build the data, make sure that you have these items:

- Python 3.9 or higher, with `shapely` 2.x
- The `osmium` CLI, for the rail layer
- A local Valhalla server, for road snapping

### 1. Download the GTFS feeds

Download the feeds into `gtfs/raw/`. Git ignores this folder.

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

### 2. Build

```sh
python3 gtfs/build.py     # buses → data/<city>.json, data/regions.json
python3 gtfs/transit.py   # rail + ferry → data/transit.json (downloads its own GTFS, uses the OSM PBF)
```

Road snapping sends requests to Valhalla at `localhost:8004`. The script keeps the results in `gtfs/snap-cache.json`. With this cache, a build takes approximately 15 seconds and does not use Valhalla.

The script compares each road line with the line from the feed. If the road line goes away from the feed line, the script keeps the feed line.

## Local services

The two services use the Geofabrik file `malaysia-singapore-brunei-latest.osm.pbf`. Put this file in `~/valhalla/malaysia/`.

| Service | Port | Function |
|---|---|---|
| Valhalla | 8004 | Snaps the bus shapes to roads (during the build only) |
| Nominatim (`mediagis/nominatim:4.4`) | 8088 | Place search in the app |

To start Nominatim, use this command. The first import takes a long time.

```sh
docker run -d --name nominatim-my -p 8088:8080 \
  -v ~/valhalla/malaysia/malaysia-singapore-brunei-latest.osm.pbf:/pbf/malaysia.osm.pbf:ro \
  -e PBF_PATH=/pbf/malaysia.osm.pbf \
  -v nominatim-my-data:/var/lib/postgresql/14/main \
  mediagis/nominatim:4.4
```

## Project files

```
index.html             the full app (HTML, CSS, JS)
data/                  built JSON for the app (in the repository)
gtfs/build.py          bus GTFS → data/<city>.json
gtfs/transit.py        rail and ferry layer → data/transit.json
gtfs/snap-cache.json   Valhalla results, one entry for each input shape
gtfs/raw/              downloaded feeds (Git ignores this folder)
```

## Data sources

- **Bus and rail timetables:** [data.gov.my GTFS Static](https://developer.data.gov.my/realtime-api/gtfs-static) (Prasarana, BAS.MY, KTMB)
- **Map tiles:** [OpenFreeMap](https://openfreemap.org). Rail lines, ferry lines, and places come from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
- **Map display:** [MapLibre GL JS](https://maplibre.org)
- **Road snapping:** [Valhalla](https://github.com/valhalla/valhalla)
- **Place search:** [Nominatim](https://nominatim.org)

The app uses only the static timetable. The time between buses and the first and last bus come from the timetable. The app does not show the live positions of the buses.
