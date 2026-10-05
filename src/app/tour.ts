import maplibregl, { type FitBoundsOptions, type GeoJSONSource, type Map as MapLibre } from 'maplibre-gl';
import { flushSync } from 'react-dom';
import { colorOf } from '../lib/data';
import { isMobile } from '../lib/geo';
import { chipColor, inkOn, railCode, railNear } from '../lib/rail';
import { sound } from '../lib/sound';
import type { LngLat } from '../types';
import { fc, railOpacity } from './layers';
import { store, type TourHud } from './state';

// Flyover: a 3D night flight along the bus's route, the line drawing itself stop by stop

const TOUR = {
  zoom: 17.2, pitch: 68,
  pull: 0.6, // zoom levels the camera pulls back each time the speed doubles
  lead: 1600, // ms to swoop down to the first stop
  look: 400, // metres ahead the camera faces
  ahead: 120, // metres ahead a stop's dot is put on the map (× the speed setting)
  nose: 25, // metres of road ahead the bus marker points along
  // Each stop: `zone` metres either side where the bus brakes and pulls away, down to `crawl` × full speed at the stop
  halt: { zone: 50, crawl: 0.15 },
  rail: { zone: 100, crawl: 0.1 }, // a stop with a rail transfer: a longer look
  stretch: 250, // metres of open road for each extra 1× of speed…
  top: 2.5, // …up to this limit. The camera pulls back as it speeds up, so the ground never rushes by
  perKm: 6, // ms per metre (= seconds per km) at 1×, between stops
  hold: 1500, // ms at the last stop before the map comes back
};
const NIGHT = {
  land: '#0a1020', water: '#04070f', road: '#1e3158', text: '#8ea3cf',
  labels: ['highway-name-major', 'label_town', 'label_city', 'label_city_capital'], // the only basemap names kept, dimmed
  // A horizon to fly towards; the haze also hides the far, half-loaded tiles
  sky: { 'sky-color': '#060b1a', 'horizon-color': '#2a4f9c', 'fog-color': '#0a1020', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.55, 'atmosphere-blend': 0 },
};

/** What the bar's buttons do */
export type TourKey = 'pause' | 'prev' | 'next' | 'rate';

interface Deps {
  map: MapLibre;
  /** A stop as a map feature */
  point: (stop: number, props?: Record<string, unknown>) => GeoJSON.Feature;
  drawSelection: () => void;
  fitCoords: (coords: LngLat[], maxZoom?: number, opts?: FitBoundsOptions) => void;
  writeHash: () => void;
  /** The flyover bar, to measure it */
  hud: () => HTMLElement | null;
}

export function createTour({ map, point, drawSelection, fitCoords, writeHash, hud }: Deps) {
  const source = (id: string) => map.getSource<GeoJSONSource>(id)!;

  /** The daytime paint, to put back after */
  let dayPaint: [layer: string, prop: string, value: unknown][] = [];
  /** Basemap name layers hidden for the flight */
  let dayLabels: string[] = [];
  function setNight(on: boolean) {
    for (const [layer, prop, value] of dayPaint) map.setPaintProperty(layer, prop, value);
    for (const id of dayLabels) map.setLayoutProperty(id, 'visibility', 'visible');
    dayPaint = [];
    dayLabels = [];
    for (const id of ['tour-buildings', 'tour-glow', 'tour-rail-ring', 'tour-rail-label']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    for (const id of ['sel-casing', 'sel-arrows', 'stops', 'stops-icon']) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
    map.setSky(on ? NIGHT.sky : { 'atmosphere-blend': 0 });
    // Phones: the tilted 3D view is the heaviest thing drawn, so fly at a lower resolution with solid buildings (no second pass)
    const sharp = Math.min(devicePixelRatio, 2);
    if (on && isMobile()) {
      map.setPixelRatio(Math.min(devicePixelRatio, 1.25));
      map.setPaintProperty('tour-buildings', 'fill-extrusion-opacity', 1);
    } else if (!on && map.getPixelRatio() !== sharp) map.setPixelRatio(sharp); // whatever the width is now: the phone may have been turned
    if (!on) return;
    railOpacity(map, 1); // rail lines in full colour: they are the transfers (the bus view fades them again after)
    const night: [layer: string, paint: Record<string, string | number>][] = [
      ['sel-line', { 'line-opacity': 1 }],
      ['sel-stops-label', { 'text-color': '#ffffff', 'text-halo-color': NIGHT.land }],
      ['station-label', { 'text-color': '#ffffff', 'text-halo-color': NIGHT.land }],
    ];
    // The basemap: land and its fills go one dark colour, so only roads, water and buildings read
    for (const l of map.getStyle().layers) {
      if (l.type !== 'background' && !('source' in l && l.source === 'openmaptiles')) continue;
      const wet = l.id.startsWith('water');
      if (l.type === 'background') night.push([l.id, { 'background-color': NIGHT.land }]);
      else if (l.type === 'fill') night.push([l.id, { 'fill-color': wet ? NIGHT.water : NIGHT.land }]);
      else if (l.type === 'line') night.push([l.id, { 'line-color': wet ? NIGHT.water : NIGHT.road }]);
      else if (l.type === 'symbol' && NIGHT.labels.includes(l.id)) night.push([l.id, { 'text-color': NIGHT.text, 'text-halo-color': NIGHT.land, 'text-opacity': 0.6 }]);
      else if (l.type === 'symbol' && map.getLayoutProperty(l.id, 'visibility') !== 'none') {
        // Every other name (neighbourhoods, side streets, lakes, shops) is noise at flying speed
        map.setLayoutProperty(l.id, 'visibility', 'none');
        dayLabels.push(l.id);
      }
    }
    for (const [layer, paint] of night) {
      for (const [prop, value] of Object.entries(paint)) {
        dayPaint.push([layer, prop, map.getPaintProperty(layer, prop)]);
        map.setPaintProperty(layer, prop, value);
      }
    }
  }

  let tour: { frame: number; coords: LngLat[]; bus: maplibregl.Marker; keys: Record<TourKey, () => void> } | null = null;
  let rate = 1; // 1×, 2× or 4×: kept from one flight to the next
  const setHud = (patch: Partial<TourHud>) => { const now = store.get().tour; if (now) store.set({ tour: { ...now, ...patch } }); };

  /** Flies the direction on screen, then the others in turn (`leg` counts them), so a two-way bus goes there and back */
  function start(leg = 1) {
    const { data, view, transit } = store.get();
    if (!data || view.kind !== 'service') return;
    stop();
    const { region } = data;
    const svcIdx = view.svc;
    const svc = region.services[svcIdx], dir = view.dir, pattern = svc.patterns[dir], { stops } = pattern;
    const coords = data.linesOf(svcIdx)[dir];
    if (coords.length < 2) return;
    const color = colorOf(region, svc);

    // The line in metres (flat earth: fine at city scale), with the distance travelled at each vertex
    const rad = Math.PI / 180, cos = Math.cos(coords[0][1] * rad);
    const xy = (lng: number, lat: number) => [lng * rad * cos * 6371000, lat * rad * 6371000];
    const pts = coords.map(([lng, lat]) => xy(lng, lat));
    const at = [0];
    for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const length = at[at.length - 1];

    const pointAt = (d: number): LngLat => {
      // The stretch `d` falls on: the first vertex at or past it
      let i = 1, hi = at.length - 1;
      while (i < hi) { const mid = (i + hi) >> 1; if (at[mid] < d) i = mid + 1; else hi = mid; }
      const k = Math.max(0, Math.min(1, (d - at[i - 1]) / (at[i] - at[i - 1] || 1)));
      const a = coords[i - 1], b = coords[i];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    };
    /** Compass heading of the road ahead (at the end: of the last stretch) */
    const heading = (d: number) => {
      const from = Math.max(0, Math.min(d, length - TOUR.look));
      const a = pointAt(from), b = pointAt(from + TOUR.look);
      return Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) / rad;
    };

    // How far along the line each stop sits: snap it to the nearest stretch, searching on from the stop before
    let seg = 0;
    const stopAt = stops.map((s) => {
      const [x, y] = xy(region.stops[s][0], region.stops[s][1]);
      let best = Infinity, d = at[seg];
      for (let j = seg; j < pts.length - 1; j++) {
        const [ax, ay] = pts[j], dx = pts[j + 1][0] - ax, dy = pts[j + 1][1] - ay;
        const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const off = Math.hypot(x - ax - dx * k, y - ay - dy * k);
        if (off < best) { best = off; d = at[j] + (at[j + 1] - at[j]) * k; seg = j; }
        else if (best < 50 && off > 200) break; // passed it: a loop coming back this way must not steal the stop
      }
      return d;
    });
    stopAt[0] = 0; // the first stop is there from the start, even if the line begins a little before it
    // Rail transfers are the highlights: a ring in the line's colour, its code, and a longer halt
    const dots = stops.map((s, k) => {
      const rail = railNear(transit, region, s);
      if (!rail.length) return point(s, { color, ring: '#ffffff', end: k === 0 || k === stops.length - 1 });
      const railColor = chipColor(rail[0].line);
      return point(s, { color, ring: railColor, end: true, rail: rail.map((r) => railCode(r.line)).join(' · '), railColor, railInk: inkOn(railColor) });
    });
    /** Like a real bus: brakes into each stop, almost halts, pulls away, and opens up on a long stretch with no stops. 1 = normal speed */
    const paceAt = (d: number) => {
      let pace = 1, clear = Infinity; // `clear`: metres of open road to the nearest stop's zone
      for (let k = 0; k < stopAt.length; k++) {
        const { zone, crawl } = dots[k].properties?.rail ? TOUR.rail : TOUR.halt;
        const gap = Math.abs(stopAt[k] - d);
        pace = Math.min(pace, crawl + (1 - crawl) * Math.min(1, gap / zone));
        clear = Math.min(clear, Math.max(0, gap - zone));
      }
      return pace < 1 ? pace : Math.min(TOUR.top, 1 + clear / TOUR.stretch);
    };

    /** Draw the line up to `t` (0–1) of its length */
    let drawn = -1;
    const reveal = (t: number) => {
      // Each change redraws the gradient for every tile the line is in, so skip the ones too small to see (the bus hides the end)
      if (t === drawn || (t < 1 && Math.abs(t - drawn) * length < 2)) return;
      drawn = t;
      // A steep `interpolate`, not `step`: a step gradient is redrawn at up to the largest texture size per tile, far too slow every frame
      for (const id of ['sel-line', 'tour-glow']) map.setPaintProperty(id, 'line-gradient', ['interpolate', ['linear'], ['line-progress'], t, color, t + 1e-6, 'rgba(0, 0, 0, 0)']);
    };
    let shown = 0, dotted = 0;
    const showStops = (d: number) => {
      let n = 0;
      while (n < stops.length && stopAt[n] <= d) n++;
      // The dots go on the map a little before the bus gets there: map data takes a few frames to land (more on a phone,
      // busy loading the city), and sent on arrival the stop would pop in after the bus had passed
      let m = n;
      while (m < stops.length && stopAt[m] <= d + TOUR.ahead * rate) m++;
      if (m !== dotted || n !== shown) {
        dotted = m;
        // The stop the bus is at wears the ring (`here`)
        source('sel-stops').setData(fc(dots.slice(0, m).map((dot, k) => (k !== n - 1 ? dot : { ...dot, properties: { ...dot.properties, here: true } }))));
      }
      if (n === shown) return;
      shown = n;
      sound.play(dots[shown - 1].properties?.rail ? 'transfer' : 'arrive');
      setHud({ stop: stops[shown - 1], shown, mins: pattern.mins?.[shown - 1] });
    };

    setNight(true);
    document.body.classList.add('touring');
    source('sel').setData(fc([{ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: coords } }]));
    source('sel-stops').setData(fc([]));
    reveal(0);
    // Put the bar on the page now, with the first stop on it: its height is measured below
    flushSync(() => {
      store.set({ tour: { svc: svcIdx, stop: stops[0], shown: 0, total: stops.length, mins: undefined, to: pattern.to, paused: false, rate } });
      showStops(0);
    });

    // The bus leading the line, and what the camera follows. A marker, not a map layer: it moves in the same frame
    // as the camera (layer data goes through a worker and lands a few frames late, which looks jittery)
    const el = document.createElement('div');
    el.className = 'tour-bus';
    // An arrow lying on the road; slices stacked along Z give it thickness
    el.innerHTML = Array.from({ length: 8 }, (_, z) => `<svg viewBox="0 0 34 46" style="transform: translateZ(${z * 1.5}px)"><path d="M17 0 34 46 17 36 0 46z"/></svg>`).join('');
    const bus = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map', subpixelPositioning: true }).setLngLat(coords[0]).addTo(map);
    /** Shortest turn from one compass angle to another, in degrees (-180 to 180) */
    const turnTo = (to: number, from: number) => ((((to - from) % 360) + 540) % 360) - 180;
    /** Sit at `d`, nose along the next few metres of road (eased, so corners in the data don't snap it round) */
    let nose = NaN;
    const placeBus = (d: number) => {
      const from = Math.max(0, Math.min(d, length - TOUR.nose));
      const a = pointAt(from), b = pointAt(from + TOUR.nose);
      const road = Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) / rad;
      nose = Number.isNaN(nose) ? road : nose + turnTo(road, nose) * 0.2;
      bus.setLngLat(pointAt(d)).setRotation(nose);
    };

    // Normal speed, in metres per ms: the same for every route, only slower when a short one would be over in a blink
    const speed = length / Math.max(30_000, length * TOUR.perKm);
    let d = 0, drop = 0, bearing = heading(0), last = performance.now(), endAt = Infinity, paused = false;
    let begin = last + TOUR.lead;
    /** Jump to a stop: the camera faces the road there at once, no long sweep round */
    const seek = (k: number) => {
      d = stopAt[Math.max(0, Math.min(stops.length - 1, k))];
      bearing = heading(d);
      nose = NaN;
      begin = 0; // skips the swoop in
    };
    const keys: Record<TourKey, () => void> = {
      pause() { paused = !paused; setHud({ paused }); },
      prev: () => seek(shown - 2),
      next: () => seek(shown),
      rate() { rate = rate >= 4 ? 1 : rate * 2; setHud({ rate }); },
    };
    // The bus sits low on screen, so most of the view is the road ahead. On phones the bar covers the bottom: measure above it
    const under = isMobile() ? hud()?.offsetHeight ?? 0 : 0;
    map.easeTo({ center: coords[0], zoom: TOUR.zoom, pitch: TOUR.pitch, bearing, duration: TOUR.lead,
      padding: { top: (innerHeight - under) * 0.15, bottom: under, left: 0, right: 0 } });

    const step = (now: number) => {
      if (!tour) return;
      const dt = Math.min(now - last, 50); // a hidden tab or a slow frame pauses the flight instead of skipping ahead
      last = now;
      if (now >= begin) {
        const pace = paceAt(d);
        if (!paused) d = Math.min(length, d + speed * pace * rate * dt);
        // Faster = further out, so the road never rushes by. Applied as a change to the zoom, so the rider's own zooming stays
        const pull = drop + (TOUR.pull * Math.log2(Math.max(1, pace)) - drop) * (1 - Math.exp(-dt / 900));
        const zoom = map.getZoom() - (pull - drop);
        drop = pull;
        map.setPaintProperty('tour-rail-ring', 'circle-radius', 24 + 6 * Math.sin(now / 250));
        // Turn towards the road ahead gently: sharp corners become sweeps
        bearing += turnTo(heading(d), bearing) * (1 - Math.exp(-dt / 700));
        map.jumpTo({ center: pointAt(d), bearing, zoom });
        reveal(d / length);
        showStops(d);
        // At the last stop: wait a moment, then go on (not while paused, and a jump back cancels it)
        if (d < length || paused) endAt = Infinity;
        else if (endAt === Infinity) endAt = now + TOUR.hold;
      }
      placeBus(d);
      if (now >= endAt) {
        if (leg >= svc.patterns.length) return stop();
        // Turn round: the panel and the link follow to the next direction
        store.set({ view: { kind: 'service', svc: svcIdx, dir: (dir + 1) % svc.patterns.length } });
        return start(leg + 1);
      }
      tour.frame = requestAnimationFrame(step);
    };
    tour = { frame: requestAnimationFrame(step), coords, bus, keys };
    writeHash(); // the link now ends in /fly: opening it starts the flight
  }

  function stop() {
    if (!tour) return;
    cancelAnimationFrame(tour.frame);
    const { coords } = tour;
    tour.bus.remove();
    tour = null;
    document.body.classList.remove('touring');
    store.set({ tour: null });
    setNight(false);
    writeHash();
    drawSelection();
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    fitCoords(coords, 16, { pitch: 0, bearing: 0, duration: 1200 });
  }

  return {
    start: () => start(),
    stop,
    get active() { return tour !== null; },
    press(key: TourKey) { tour?.keys[key](); },
    destroy() {
      if (tour) cancelAnimationFrame(tour.frame);
      tour = null;
      document.body.classList.remove('touring');
    },
  };
}
