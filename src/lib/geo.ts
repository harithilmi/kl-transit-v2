import type { LngLat, Place, Region, RegionMeta } from '../types';

/** How far "nearby" stops reach from a searched place, in metres */
export const WALK = 500;

export const isMobile = () => innerWidth <= 800;

/** Room the panel takes from the map: a side panel on desktop, a bottom sheet on phones */
export const pad = () => (isMobile()
  ? { top: 70, bottom: innerHeight * 0.46 + 20, left: 30, right: 60 }
  : { top: 60, bottom: 60, left: 380 + 50, right: 80 });

/** Google encoded polyline (precision 5) → [lng, lat][] */
export function decode(str: string) {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

/** Is (x, y) inside a polygon ring? (ray casting) */
function inRing(ring: GeoJSON.Position[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** City serving a place: inside its stops' walk area first (some city boxes overlap), else its box. Current city wins ties */
export function regionAt(regions: RegionMeta[], current: string, { lng, lat }: { lng: number; lat: number }) {
  const ordered = [...regions].sort((a, b) => Number(b.id === current) - Number(a.id === current));
  return ordered.find((r) => r.area.some(([outer, ...holes]) => inRing(outer, lng, lat) && !holes.some((h) => inRing(h, lng, lat))))
    ?? ordered.find(({ bounds: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n);
}

/** Straight-line metres (equirectangular: plenty accurate at walking range) */
export function metres({ lng, lat }: { lng: number; lat: number }, [sLng, sLat]: readonly [number, number, ...unknown[]]) {
  const k = Math.PI / 180;
  return Math.hypot((sLng - lng) * k * Math.cos(((lat + sLat) / 2) * k), (sLat - lat) * k) * 6371000;
}

/** Stops within WALK of a place, nearest first; if none, just the single nearest */
export function nearStops(region: Region, place: Place) {
  const all = region.stops.map((s, i) => ({ i, d: metres(place, s) })).sort((a, b) => a.d - b.d);
  const near = all.filter(({ d }) => d <= WALK);
  return near.length ? near : all.slice(0, 1);
}

export const distance = (d: number) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
