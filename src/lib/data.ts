import type { LngLat, Region, RegionMeta, Service, Transit } from '../types';
import { decode } from './geo';

declare global {
  interface Window {
    /** Requests started by index.html while this code was still downloading */
    boot?: { regions: Promise<RegionMeta[]>; first: Promise<{ id: string; region: Promise<Region> }> };
  }
}

const get = <T>(name: string): Promise<T> => fetch(`data/${name}.json`, { cache: 'no-cache' }).then((r) => {
  if (!r.ok) throw new Error(`data/${name}.json: ${r.status}`);
  return r.json();
});

export const loadRegions = () => window.boot?.regions ?? get<RegionMeta[]>('regions');

const regionCache = new Map<string, Promise<Region>>();
window.boot?.first.then(({ id, region }) => { if (!regionCache.has(id)) regionCache.set(id, region); }, () => {});

export async function loadRegion(id: string) {
  await window.boot?.first.catch(() => {}); // so the early request is used, not repeated
  let region = regionCache.get(id);
  if (!region) {
    region = get<Region>(id);
    regionCache.set(id, region);
    region.catch(() => regionCache.delete(id)); // a failed download may be tried again
  }
  return region;
}

export const loadTransit = () => get<Transit>('transit').catch(() => null);

export interface RegionIndex {
  region: Region;
  /** stop → services passing it */
  stopServices: number[][];
  /** A service's line in each direction, decoded when first asked for */
  linesOf: (svc: number) => LngLat[][];
  /** Link keys for services: number alone unless two operators share it */
  keys: string[];
  /** Link keys for stops: the stop code when it's unique (survives data rebuilds), else the index */
  stopKeys: string[];
}

const indexes = new WeakMap<Region, RegionIndex>();

/** Everything derived from a loaded region (worked out once per region) */
export function indexRegion(region: Region): RegionIndex {
  const made = indexes.get(region);
  if (made) return made;

  const stopServices: number[][] = region.stops.map(() => []);
  region.services.forEach((svc, i) => {
    const seen = new Set(svc.patterns.flatMap((p) => p.stops));
    for (const s of seen) stopServices[s].push(i);
  });
  const lines: (LngLat[][] | undefined)[] = [];
  const linesOf = (svc: number) => (lines[svc] ??= region.services[svc].patterns.map((p) => decode(p.shape)));

  const counts = new Map<string, number>();
  for (const s of region.services) counts.set(s.no, (counts.get(s.no) ?? 0) + 1);
  const keys = region.services.map((s) => ((counts.get(s.no) ?? 0) > 1 ? `${s.no}~${s.op}` : s.no));
  const codeCount = new Map<string, number>();
  for (const st of region.stops) if (st[3]) codeCount.set(st[3], (codeCount.get(st[3]) ?? 0) + 1);
  const stopKeys = region.stops.map((st, i) => (st[3] && codeCount.get(st[3]) === 1 ? st[3] : String(i)));

  const index = { region, stopServices, linesOf, keys, stopKeys };
  indexes.set(region, index);
  return index;
}

export const colorOf = (region: Region, svc: Service) => svc.color ?? region.operators[svc.op].color;
