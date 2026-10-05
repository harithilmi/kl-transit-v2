import type { Region, Transit, TransitLine } from '../types';
import { metres } from './geo';

const WALK_TO_RAIL = 300; // m
/** Short code riders see on signage */
const RAIL_CODE: Record<string, string> = { PH: 'SP', KGL: 'KG', PYL: 'PY' };
export const railCode = (l: TransitLine) =>
  l.mode === 'komuter' ? 'KTM' : l.mode === 'ferry' ? 'Ferry' : l.mode === 'ets' ? 'ETS' : RAIL_CODE[l.id] ?? l.id;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const brightness = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Light line colours (MRT yellow) need dark text */
export const inkOn = (hex: string) => (brightness(rgb(hex)) > 170 ? '#1d1d1f' : '#fff');

/** Light line colours (MRT yellow, monorail lime) darkened so their names read on the map */
export function readable(hex: string) {
  const c = rgb(hex), k = brightness(c) > 150 ? 0.55 : 1;
  return `rgb(${c.map((v) => Math.round(v * k)).join(',')})`;
}

export const KTM = '#1c4c9c';
/** Komuter lines share one chip, so it gets KTM's brand blue rather than one line's colour */
export const chipColor = (l: TransitLine) => (l.mode === 'komuter' ? KTM : l.color);

export interface RailNear { line: TransitLine; station: string; d: number }

/** Rail/ferry lines at stations within a short walk of a stop, nearest first */
export function railNear(transit: Transit | null, region: Region, stop: number): RailNear[] {
  if (!transit) return [];
  const s = region.stops[stop];
  const found = new Map<string, RailNear>();
  const near = transit.stations
    .map((st) => ({ st, d: metres(st, s) }))
    .filter(({ d }) => d <= WALK_TO_RAIL)
    .sort((a, b) => a.d - b.d);
  for (const { st, d } of near) {
    for (const id of st.lines) {
      const line = transit.lines.find((l) => l.id === id);
      // One chip per code: a station on two Komuter lines is still just "KTM"
      if (line && !found.has(railCode(line))) found.set(railCode(line), { line, station: st.name, d });
    }
  }
  return [...found.values()];
}
