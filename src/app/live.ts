import type { GeoJSONSource, Map as MapLibre } from 'maplibre-gl';
import { colorOf } from '../lib/data';
import { parseVehicles } from '../lib/gtfsRealtime';
import type { LngLat } from '../types';
import { fc, STOP } from './layers';
import { store } from './state';

// Live buses (data.gov.my GTFS Realtime)
// Only Rapid KL publishes positions we can match to routes; the feed refreshes every 30 s
const LIVE = {
  region: 'klang-valley',
  feeds: ['rapid-bus-kl', 'rapid-bus-mrtfeeder'],
  url: (feed: string) => `https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana/?category=${feed}`,
  every: 30_000,
  staleAfter: 120, // seconds: older pings are parked or offline buses
};

interface LiveBus { from: LngLat; to: LngLat; bearing: number; speed: number; time: number; svc: number; route: string }

export function createLive(map: MapLibre) {
  const buses = new Map<string, LiveBus>();
  let movedAt = 0; // when the last poll landed: buses glide from `from` to `to` until the next one
  let timer = 0, frame = 0;

  /** Where a bus is drawn right now, part-way between its last two pings */
  function busAt({ from, to }: LiveBus, now = performance.now()): LngLat {
    const k = Math.min(1, (now - movedAt) / LIVE.every);
    return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
  }

  function draw() {
    const source = map.getSource<GeoJSONSource>('buses');
    if (!source) return;
    const { data, view } = store.get();
    const only = view.kind === 'service' ? view.svc : -1; // a bus's page shows just its own buses
    const now = performance.now();
    const features: GeoJSON.Feature[] = [];
    for (const [id, b] of buses) {
      if (only >= 0 && b.svc !== only) continue;
      const svc = data?.region.services[b.svc];
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: busAt(b, now) },
        properties: { id, svc: b.svc, no: svc?.no ?? b.route, color: svc && data ? colorOf(data.region, svc) : STOP, bearing: b.bearing, speed: Math.round(b.speed), time: b.time } });
    }
    source.setData(fc(features));
  }

  // ~12 redraws a second while buses glide: smooth enough, and easy on phones
  function animate() {
    cancelAnimationFrame(frame);
    let last = 0;
    const step = (now: number) => {
      if (now - last > 80) { last = now; draw(); }
      if (now - movedAt < LIVE.every && buses.size) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  async function poll() {
    const region = store.get().data?.region;
    if (region?.id !== LIVE.region) return;
    // Rapid KL pings carry the GTFS route id ("U2500"); feeder pings carry the bus number ("T460", "T155 Inbound")
    const byId = new Map(region.services.flatMap((s, i) => [[s.no, i], [s.id, i]] as [string, number][]));
    const feeds = await Promise.all(LIVE.feeds.map((f) => fetch(LIVE.url(f)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)));
    if (store.get().data?.region !== region) return; // city changed while loading
    if (feeds.every((f) => !f)) return; // offline: keep what we have
    const now = performance.now(), fresh = Date.now() / 1000 - LIVE.staleAfter;
    const seen = new Set<string>();
    let unmatched = 0;
    for (const feed of feeds) {
      if (!feed) continue;
      for (const v of parseVehicles(new Uint8Array(feed))) {
        if (!v.id || !v.lat || !v.lng || v.time < fresh) continue; // GPS glitches report 0,0
        const svc = byId.get(v.route) ?? byId.get(v.route.split(' ')[0]) ?? -1;
        if (svc < 0) unmatched++;
        const old = buses.get(v.id);
        const to: LngLat = [v.lng, v.lat];
        // Glide from where it is drawn now; a new bus (or a GPS jump of ~1 km+) just appears in place
        const at = old ? busAt(old, now) : to;
        const from = Math.abs(at[0] - to[0]) + Math.abs(at[1] - to[1]) < 0.01 ? at : to;
        buses.set(v.id, { from, to, bearing: v.bearing, speed: v.speed, time: v.time, svc, route: v.route });
        seen.add(v.id);
      }
    }
    for (const id of buses.keys()) if (!seen.has(id)) buses.delete(id);
    if (unmatched) console.info(`Live buses: ${unmatched} of ${buses.size} on routes this map doesn't have`);
    movedAt = now;
    animate();
  }

  /** Poll only while it's worth it: Klang Valley on screen, tab visible */
  function sync() {
    clearInterval(timer);
    const here = store.get().regionId === LIVE.region;
    if (here && !document.hidden) { poll(); timer = window.setInterval(poll, LIVE.every); }
    if (!here) { buses.clear(); draw(); }
  }
  document.addEventListener('visibilitychange', sync);

  return {
    draw,
    sync,
    destroy() {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', sync);
    },
  };
}
