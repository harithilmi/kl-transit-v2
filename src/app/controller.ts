import maplibregl, { type FilterSpecification, type FitBoundsOptions, type GeoJSONSource } from 'maplibre-gl';
import { colorOf, indexRegion, loadRegion, loadTransit } from '../lib/data';
import { nearStops, pad, regionAt } from '../lib/geo';
import { readable } from '../lib/rail';
import { sound } from '../lib/sound';
import type { LngLat, Place, RegionMeta, View } from '../types';
import { addLayers, fc, gradient, markArea, railOpacity, ROUTE_LABELS, STOP } from './layers';
import { createLive } from './live';
import { createPlaceSearch } from './places';
import { initialState, store, tipStore } from './state';
import { createTour, type TourKey } from './tour';

const PEEK_BELOW = 15; // stop names appear from here
const PICKABLE = ['pin-halo', 'sel-stops-dot', 'stops-icon', 'stops'];

export type Controller = ReturnType<typeof createController>;

/**
 * The map and everything that happens on it. React draws the panel from the store;
 * this draws the map, and holds the actions the panel's buttons call.
 */
export function createController(container: HTMLElement, regions: RegionMeta[]) {
  let dead = false;
  store.set(initialState(regions[0].id));

  const map = new maplibregl.Map({
    container,
    style: 'https://tiles.openfreemap.org/styles/positron',
    bounds: regions[0].bounds,
    maxBounds: [[98.5, 0], [120.5, 8]],
    minZoom: 5,
    attributionControl: { compact: true },
    pixelRatio: Math.min(devicePixelRatio, 2),
    fadeDuration: 0,
    renderWorldCopies: false,
    boxZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 70, // only the flyover tilts this far
  });
  map.touchZoomRotate.disableRotation();
  const source = (id: string) => map.getSource<GeoJSONSource>(id)!;

  const mapReady = new Promise<void>((resolve) => map.on('load', () => {
    addLayers(map, regions);
    container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    resolve();
  }));

  // Rail + ferry layer, and the transfer chips in the panel
  const transitReady = Promise.all([loadTransit(), mapReady]).then(([transit]) => {
    if (!transit || dead) return;
    store.set({ transit });
    source('transit').setData(fc(transit.lines.flatMap((l) => l.pieces.map((p): GeoJSON.Feature => ({ type: 'Feature',
      properties: { mode: l.mode, color: l.color, name: l.name, ink: readable(l.color), s: p.s, n: p.n },
      geometry: { type: 'LineString', coordinates: p.c } })))));
    source('stations').setData(fc(transit.stations.map((st) => ({ type: 'Feature', properties: { name: st.name, lines: st.lines },
      geometry: { type: 'Point', coordinates: [st.lng, st.lat] } }))));
  });

  // ---------- Drawing ----------

  const line = (coords: LngLat[], props: Record<string, unknown>): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
  const point = (i: number, props: Record<string, unknown> = {}): GeoJSON.Feature => {
    const s = store.get().data!.region.stops[i];
    return { type: 'Feature', properties: { i, name: s[2], code: s[3], ...props }, geometry: { type: 'Point', coordinates: [s[0], s[1]] } };
  };
  const tint = (hex: string) => map.setPaintProperty('sel-line', 'line-gradient', gradient(hex));

  function drawRegion() {
    const { data } = store.get();
    if (!data) return;
    source('stops').setData(fc(data.region.stops.map((_, i) => point(i))));
    markArea(map, data.region.id);
  }

  /** The colour most buses at a stop share — all their lines use it, so the map stays calm */
  function stopColor(stop: number) {
    const { data } = store.get();
    if (!data) return STOP;
    const counts = new Map<string, number>();
    for (const s of data.stopServices[stop]) { const c = colorOf(data.region, data.region.services[s]); counts.set(c, (counts.get(c) ?? 0) + 1); }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? STOP;
  }

  /** All buses through a stop in one colour; `focus` (a service) keeps its own colour, the rest fade */
  function stopLines(stop: number, focus = -1) {
    const { data } = store.get();
    if (!data) return [];
    const { region, stopServices } = data;
    const color = stopColor(stop);
    tint(focus >= 0 ? colorOf(region, region.services[focus]) : color);
    return stopServices[stop]
      .flatMap((s) => data.linesOf(s).map((coords) => line(coords, { svc: s, no: region.services[s].no, thin: true, color: s === focus ? colorOf(region, region.services[s]) : color, dim: focus >= 0 && s !== focus })))
      .sort((a, b) => Number(b.properties?.dim) - Number(a.properties?.dim));
  }

  // Pinned and hovered stops draw themselves (with their own label), so every other stop layer skips them
  let pinned = -1, hoveredStop = -1;
  /** Stops of the bus being viewed (drawn by the route layers) */
  let onRoute: number[] = [];
  function hideStops() {
    const without = (ids: number[]): FilterSpecification | null => {
      const skip = ids.filter((i) => i >= 0);
      return skip.length ? ['!', ['in', ['get', 'i'], ['literal', skip]]] : null;
    };
    for (const id of ['stops', 'stops-icon']) map.setFilter(id, without([pinned, hoveredStop, ...onRoute]));
    const others = without([pinned, hoveredStop]);
    map.setFilter('sel-stops-dot', others);
    map.setFilter('sel-stops-label', others ? ['all', ROUTE_LABELS, others] : ROUTE_LABELS);
  }

  /** Selected stop: drawn by the pin layers, hidden from the regular stop layers */
  function setPin(stop: number) {
    source('pin').setData(fc(stop >= 0 ? [point(stop)] : []));
    // Pin takes the stop's bus colour, same as its lines
    map.setPaintProperty('pin-halo', 'circle-stroke-color', stop >= 0 ? stopColor(stop) : STOP);
    pinned = stop;
    hideStops();
  }

  function drawSelection() {
    const { data, view, showAll } = store.get();
    if (!data) return;
    hovered = -1;
    const { region } = data;
    let sel: GeoJSON.Feature[] = [];
    let selStops: GeoJSON.Feature[] = [];

    if (view.kind === 'service') {
      const svc = region.services[view.svc];
      const color = colorOf(region, svc);
      const dir = view.dir;
      tint(color);
      sel = data.linesOf(view.svc).map((coords, d) => line(coords, { color, dim: d !== dir }))
        .sort((a, b) => Number(b.properties?.dim) - Number(a.properties?.dim));
      const p = svc.patterns[dir];
      // A loop ends where it starts: label that terminal once
      const last = p.stops.length - 1;
      const loopBack = region.stops[p.stops[last]][2] === region.stops[p.stops[0]][2];
      selStops = p.stops.map((s, k) => point(s, { color, end: k === 0 || (k === last && !loopBack) }));
    } else if (view.kind === 'stop') {
      // No lines by default: the rider asks (button) or points at a bus (hover)
      sel = showAll ? stopLines(view.stop) : [];
    }
    source('sel').setData(fc(sel));
    source('sel-stops').setData(fc(selStops));
    setPin(view.kind === 'stop' ? view.stop : -1);
    // The place marker stays while you look at stops/buses opened from it
    const place = view.kind === 'place' ? view.place : view.kind === 'home' ? null : fromPlace;
    source('place').setData(fc(place ? [{ type: 'Feature', properties: { name: place.name }, geometry: { type: 'Point', coordinates: [place.lng, place.lat] } }] : []));
    // Bus view: other stops stay (faded) for context; the route's own stops are drawn by the route layers
    const faded = view.kind === 'service';
    map.setPaintProperty('stops', 'circle-opacity', faded ? 0.45 : 1);
    map.setPaintProperty('stops', 'circle-stroke-opacity', faded ? 0.45 : 1);
    map.setPaintProperty('stops-icon', 'text-opacity', faded ? 0.5 : 1);
    railOpacity(map, faded ? 0.35 : 1);
    onRoute = view.kind === 'service' ? region.services[view.svc].patterns[view.dir].stops : [];
    hideStops();
    live.draw();
  }

  /** Padding for fitBounds: flyTo/easeTo leave theirs on the map and fitBounds adds to it, so pass only the difference */
  function fitPad() {
    const want = pad(), has = map.getPadding();
    return { top: want.top - (has.top ?? 0), bottom: want.bottom - (has.bottom ?? 0), left: want.left - (has.left ?? 0), right: want.right - (has.right ?? 0) };
  }

  function fitCoords(coords: LngLat[], maxZoom = 16, opts: FitBoundsOptions = {}) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) b.extend(c);
    map.fitBounds(b, { padding: fitPad(), maxZoom, duration: 700, ...opts });
  }

  /** A short message in the pill at the top */
  let noticeTimer = 0;
  function notify(notice: string) {
    store.set({ notice });
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => store.set({ notice: null }), 2000);
  }

  // ---------- Navigation (hash = shareable state) ----------

  function writeHash() {
    const { data, view, regionId } = store.get();
    if (!data) return;
    const tail = view.kind === 'service' ? `/bus/${encodeURIComponent(data.keys[view.svc])}${view.dir ? '/2' : ''}${tour.active ? '/fly' : ''}`
      : view.kind === 'stop' ? `/stop/${encodeURIComponent(data.stopKeys[view.stop])}`
      : view.kind === 'place' ? `/place/${view.place.lat.toFixed(5)},${view.place.lng.toFixed(5)}/${encodeURIComponent(view.place.name)}` : '';
    history.replaceState(null, '', `#/${regionId}${tail}`);
  }

  // A stop or bus tapped once in the panel: the map shows it, the second tap opens it
  let peeked = -1, peekedSvc = -1;
  function peekStop(stop: number) {
    const { data } = store.get();
    if (!data) return;
    peeked = stop; // zoom only (no highlight); the stop is selected on the 2nd tap
    const s = data.region.stops[stop];
    map.flyTo({ center: [s[0], s[1]], zoom: Math.max(map.getZoom(), 17), padding: pad(), duration: 600 });
  }

  let fromStop = -1; // stop a bus was opened from, so ✕ returns there
  /** Place a stop was opened from (kept through its buses), so ✕ returns there */
  let fromPlace: Place | null = null;
  function go(next: View, { fly = true } = {}) {
    tour.stop();
    peeked = peekedSvc = -1;
    const { view, data } = store.get();
    if (next.kind === 'service') fromStop = view.kind === 'stop' ? view.stop : view.kind === 'service' ? fromStop : -1;
    if (next.kind === 'stop') fromPlace = view.kind === 'place' ? view.place : view.kind === 'service' ? fromPlace : null;
    else if (next.kind !== 'service') fromPlace = null;
    store.set({ view: next, showAll: false, highlighted: -1 });
    drawSelection();
    writeHash();
    if (!data || !fly) return;
    if (next.kind === 'service') {
      fitCoords(data.linesOf(next.svc)[next.dir]);
    } else if (next.kind === 'stop') {
      const s = data.region.stops[next.stop];
      map.flyTo({ center: [s[0], s[1]], zoom: Math.max(map.getZoom(), 15.5), padding: pad(), duration: 700 });
    } else if (next.kind === 'place') {
      const { place } = next, { stops } = data.region;
      // Frame the place with the stops listed (or the lone nearest one)
      fitCoords([[place.lng, place.lat], ...nearStops(data.region, place).map(({ i }): LngLat => [stops[i][0], stops[i][1]])], 16.5);
    }
  }

  async function setRegion(id: string, next: View = { kind: 'home' }, fit = true) {
    tour.stop();
    store.set({ regionId: id, notice: 'Loading…' });
    const region = await loadRegion(id).catch(() => null);
    await mapReady;
    if (dead) return;
    store.set({ notice: null });
    if (store.get().regionId !== id) return; // switched again while loading
    if (!region) {
      // The download failed: stay in the city on screen
      store.set({ regionId: store.get().data?.region.id ?? id });
      return notify('Could not load this city');
    }
    const data = indexRegion(region);
    if (data !== store.get().data) {
      // Another city: its stop and bus numbers mean nothing here, so nothing is open and ✕ has nowhere to return to
      fromStop = -1;
      fromPlace = null;
      store.set({ data, view: { kind: 'home' }, showAll: false, highlighted: -1 });
    }
    document.documentElement.style.setProperty('--accent', region.operators[0].color);
    drawRegion();
    live.sync();
    if (fit && next.kind === 'home') map.fitBounds(region.bounds, { padding: fitPad(), duration: 0 });
    go(next, { fly: next.kind !== 'home' });
  }

  function fromHash() {
    const [, id, kind, key, dir] = location.hash.split('/');
    const meta = regions.find((r) => r.id === id) ?? regions[0];
    // `dir` is the bus direction, or a place's name in #/<city>/place/<lat>,<lng>/<name>
    return { id: meta.id, kind, key: key ? decodeURIComponent(key) : '', dir: dir === '2' ? 1 : 0, name: dir ? decodeURIComponent(dir) : '', fly: location.hash.endsWith('/fly') };
  }

  /** Resolve a hash key once the region is loaded */
  async function openFromHash() {
    const h = fromHash();
    const region = await loadRegion(h.id);
    if (dead) return;
    const { keys, stopKeys } = indexRegion(region);
    const svc = keys.indexOf(h.key);
    const stop = stopKeys.indexOf(h.key);
    const [lat, lng] = h.key.split(',').map(Number);
    const next: View = h.kind === 'bus' && svc >= 0 ? { kind: 'service', svc, dir: Math.min(h.dir, region.services[svc].patterns.length - 1) }
      : h.kind === 'stop' && stop >= 0 ? { kind: 'stop', stop }
      : h.kind === 'place' && Number.isFinite(lat) && Number.isFinite(lng) ? { kind: 'place', place: { name: h.name || 'Dropped pin', detail: '', lat, lng } }
      : { kind: 'home' };
    await setRegion(h.id, next);
    if (!h.fly) return;
    await transitReady; // the flight marks the stops where you change to rail
    if (!dead) tour.start();
  }

  // ---------- Hover ----------

  // Hover a bus: preview its line (home), or single it out among the buses at a stop
  let hovered = -1;
  function focusService(svcIdx: number) {
    const { data, view, showAll } = store.get();
    if (!data || svcIdx === hovered) return;
    hovered = svcIdx;
    if (view.kind === 'home') {
      const color = svcIdx >= 0 ? colorOf(data.region, data.region.services[svcIdx]) : '';
      if (color) tint(color);
      source('sel').setData(fc(svcIdx >= 0 ? data.linesOf(svcIdx).map((coords) => line(coords, { color })) : []));
    } else if (view.kind === 'stop') {
      // Hover shows just that bus; with "show all" on, the rest stay faded behind it
      const lines = showAll ? stopLines(view.stop, svcIdx) : svcIdx >= 0 ? stopLines(view.stop, svcIdx).filter((f) => f.properties?.svc === svcIdx) : [];
      source('sel').setData(fc(lines));
      store.set({ highlighted: svcIdx });
    }
  }

  function hoverStop(stop: number) {
    const { data, view } = store.get();
    if (!data || stop === hoveredStop) return;
    hoveredStop = stop;
    const color = view.kind === 'service' ? colorOf(data.region, data.region.services[view.svc]) : stop >= 0 ? stopColor(stop) : STOP;
    source('hover-stop').setData(fc(stop >= 0 ? [point(stop, { color })] : []));
    hideStops();
  }

  let hoveredArea = '';
  function hoverArea(id: string) {
    if (id === hoveredArea) return;
    if (hoveredArea) map.setFeatureState({ source: 'areas', id: hoveredArea }, { hover: false });
    if (id) map.setFeatureState({ source: 'areas', id }, { hover: true });
    hoveredArea = id;
  }

  // ---------- Map events ----------

  type Box = [[number, number], [number, number]];
  const hideTip = () => { if (tipStore.get().show) tipStore.set({ show: false }); };

  map.on('click', (e) => {
    const { data, view } = store.get();
    if (!data) return;
    const box: Box = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    // A live bus opens its route (already open: nothing to do)
    const bus = map.queryRenderedFeatures(box, { layers: ['buses'] })[0];
    if (bus) {
      if (bus.properties.svc >= 0 && view.kind !== 'service') { sound.play('bus'); go({ kind: 'service', svc: bus.properties.svc, dir: 0 }); }
      return;
    }
    const stop = map.queryRenderedFeatures(box, { layers: PICKABLE })[0];
    if (stop) {
      const i: number = stop.properties.i;
      sound.play('stop');
      // Zoomed out (dots): 1st click zooms to name level, 2nd opens it
      if (map.getZoom() < PEEK_BELOW && peeked !== i && !(view.kind === 'stop' && view.stop === i)) {
        return map.easeTo({ center: stop.geometry.type === 'Point' ? stop.geometry.coordinates as LngLat : e.lngLat, zoom: PEEK_BELOW + 0.5, padding: pad(), duration: 500 });
      }
      return go({ kind: 'stop', stop: i });
    }
    // At a stop, clicking one of its bus lines opens that bus
    const route = view.kind === 'stop' ? map.queryRenderedFeatures(box, { layers: ['sel-line'] })[0] : undefined;
    if (route) { sound.play('bus'); return go({ kind: 'service', svc: route.properties.svc, dir: 0 }); }
    // Click another city's area → switch to it
    const area = map.queryRenderedFeatures(e.point, { layers: ['area-fill'] }).find((f) => f.properties.id !== data.region.id);
    if (area) { sound.play('city'); hoverArea(''); setRegion(area.properties.id); }
  });

  map.on('mousemove', (e) => {
    const { data, view } = store.get();
    if (!data) return;
    const box: Box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const at = { x: e.originalEvent.clientX, y: e.originalEvent.clientY };
    const bus = map.queryRenderedFeatures(box, { layers: ['buses'] })[0];
    if (bus) {
      const { no, speed, time } = bus.properties;
      tipStore.set({ show: true, tag: String(no), text: `${speed} km/h · ${Math.max(0, Math.round(Date.now() / 1000 - time))} s ago`, ...at });
      map.getCanvas().style.cursor = bus.properties.svc >= 0 ? 'pointer' : '';
      return;
    }
    const stop = map.queryRenderedFeatures(box, { layers: PICKABLE })[0];
    const route = !stop && view.kind === 'stop' ? map.queryRenderedFeatures(box, { layers: ['sel-line'] })[0] : undefined;
    if (view.kind === 'stop') focusService(route ? route.properties.svc : -1);
    const area = stop || route ? undefined : map.queryRenderedFeatures(e.point, { layers: ['area-fill'] }).find((f) => f.properties.id !== data.region.id);
    hoverArea(area ? String(area.properties.id) : '');
    map.getCanvas().style.cursor = stop || route || area ? 'pointer' : '';
    if (area) tipStore.set({ show: true, tag: '', text: `Switch to ${area.properties.name}`, ...at });
    else if (route) tipStore.set({ show: true, tag: '', text: data.region.services[route.properties.svc].no, ...at });
    else if (stop && map.getZoom() < 17 && !map.isMoving()) tipStore.set({ show: true, tag: stop.properties.code ?? '', text: stop.properties.name, ...at });
    else hideTip();
  });
  map.on('movestart', hideTip);
  const leaveMap = () => { hideTip(); hoverArea(''); };
  map.getCanvas().addEventListener('mouseleave', leaveMap);

  // ---------- Parts ----------

  let hudEl: HTMLElement | null = null;
  const tour = createTour({ map, point, drawSelection, fitCoords, writeHash, hud: () => hudEl });
  const live = createLive(map);
  const places = createPlaceSearch(regions);

  // replaceState doesn't fire this, so it only runs for pasted/edited URLs
  addEventListener('hashchange', openFromHash);
  openFromHash();

  // ---------- What the panel and the buttons call ----------

  return {
    regions,

    destroy() {
      dead = true;
      removeEventListener('hashchange', openFromHash);
      clearTimeout(noticeTimer);
      tour.destroy();
      live.destroy();
      places.destroy();
      map.remove();
    },

    /** The flyover bar tells the map where it is, so the flight can leave room for it */
    setHud(el: HTMLElement | null) { hudEl = el; },

    setQuery(query: string) {
      store.set({ query });
      places.search(query.trim().toLowerCase()); // first, so the list can say "Searching places…"
      if (store.get().view.kind !== 'home') go({ kind: 'home' }, { fly: false });
    },

    clearQuery() { store.set({ query: '' }); },

    pickCity(id: string) {
      store.set({ query: '' });
      if (id !== store.get().regionId) { sound.play('city'); setRegion(id); }
    },

    /** ✕: back to where this bus or stop was opened from */
    back() {
      const { view } = store.get();
      sound.play('close');
      if (view.kind === 'service' && fromStop >= 0) go({ kind: 'stop', stop: fromStop });
      else if (view.kind === 'stop' && fromPlace) go({ kind: 'place', place: fromPlace });
      else go({ kind: 'home' }, { fly: false });
    },

    openService(svc: number, dir = 0) {
      const { data, view } = store.get();
      if (!data) return;
      sound.play('bus');
      // At a stop, like stop rows: 1st tap frames the bus's route, 2nd opens it
      if (view.kind === 'stop' && peekedSvc !== svc) {
        peekedSvc = svc;
        focusService(svc);
        return fitCoords(data.linesOf(svc)[dir]);
      }
      go({ kind: 'service', svc, dir });
    },

    openStop(stop: number) {
      const { view } = store.get();
      sound.play('stop');
      // Any stop row in the sidebar: 1st tap zooms to the stop, 2nd opens it
      if (peeked !== stop && !(view.kind === 'stop' && view.stop === stop)) return peekStop(stop);
      go({ kind: 'stop', stop });
    },

    /** City serving a place: its own, if it is not in the one on screen */
    openPlace(place: Place) {
      sound.play('stop');
      const home = regionAt(regions, store.get().regionId, place);
      if (home && home.id !== store.get().regionId) setRegion(home.id, { kind: 'place', place });
      else go({ kind: 'place', place });
    },

    setDirection(dir: number) {
      const { view } = store.get();
      sound.play('tick');
      if (view.kind === 'service') go({ ...view, dir });
    },

    togglePassing() {
      const { data, view, showAll } = store.get();
      if (!data || view.kind !== 'stop') return;
      sound.play('tick');
      store.set({ showAll: !showAll });
      drawSelection();
      if (!showAll) fitCoords(data.stopServices[view.stop].flatMap((svc) => data.linesOf(svc).flat()), 15);
    },

    startTour() {
      sound.play('tick');
      tour.start();
    },

    /** The flyover bar's buttons; the keys (Esc, space, ← →) press the same buttons */
    pressTour(key: TourKey | 'end') {
      if (!tour.active) return;
      sound.play(key === 'end' ? 'close' : 'tick');
      if (key === 'end') tour.end(); else tour.press(key);
    },

    /** The pointer is over a row of the panel (or none: -1) */
    hoverRow(stop: number, svc: number) {
      hoverStop(stop);
      if (store.get().view.kind !== 'service') focusService(svc);
    },

    leaveRows() {
      hovered = -1;
      hoverStop(-1);
      if (store.get().highlighted >= 0) store.set({ highlighted: -1 });
      drawSelection();
      if (peekedSvc >= 0) focusService(peekedSvc);
    },

    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),

    /** Near me: jump to the city you're in */
    locate() {
      const fail = () => notify('Location unavailable');
      if (!navigator.geolocation) return fail();
      navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        const here: LngLat = [coords.longitude, coords.latitude];
        const inside = regionAt(regions, store.get().regionId, { lng: here[0], lat: here[1] });
        if (inside && inside.id !== store.get().regionId) await setRegion(inside.id, { kind: 'home' }, false);
        if (!dead) map.flyTo({ center: here, zoom: 16, padding: pad(), duration: 900 });
      }, fail);
    },
  };
}
