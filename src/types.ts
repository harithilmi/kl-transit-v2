export type Stop = [lng: number, lat: number, name: string, code: string];
export type LngLat = [lng: number, lat: number];

export interface Pattern {
  to: string;
  loop: boolean;
  stops: number[];
  mins: number[] | null;
  shape: string;
  trips: number;
  first: string | null;
  last: string | null;
}
export interface Service { id: string; no: string; name: string; op: number; color: string | null; patterns: Pattern[] }
export interface Operator { name: string; color: string }
export type Bounds = [west: number, south: number, east: number, north: number];
export interface Region { id: string; bounds: Bounds; operators: Operator[]; stops: Stop[]; services: Service[] }
export interface RegionMeta { id: string; name: string; bounds: Bounds; operators: string[]; services: number; area: GeoJSON.Position[][][] }

export interface Place { name: string; detail: string; lng: number; lat: number }
export type View =
  | { kind: 'home' }
  | { kind: 'service'; svc: number; dir: number }
  | { kind: 'stop'; stop: number }
  | { kind: 'place'; place: Place };

export interface TransitLine { id: string; name: string; mode: string; color: string; pieces: { c: GeoJSON.Position[]; s: number; n: number }[] }
export interface Station { name: string; lng: number; lat: number; lines: string[] }
export interface Transit { lines: TransitLine[]; stations: Station[] }
