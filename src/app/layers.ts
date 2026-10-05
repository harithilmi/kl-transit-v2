import type { LayerSpecification, Map as MapLibre } from 'maplibre-gl';
import { WALK } from '../lib/geo';
import type { RegionMeta } from '../types';

/** A MapLibre style expression (its own types can't follow ones built from parts) */
type Expr = any;

const RESTYLE: Record<string, Record<string, string | number>> = {
  background: { 'background-color': '#f4f2ee' },
  water: { 'fill-color': '#b9daf0' },
  waterway: { 'line-color': '#b9daf0' },
  park: { 'fill-color': '#d5ebc8', 'fill-opacity': 1 },
  landcover_wood: { 'fill-color': '#d5ebc8', 'fill-opacity': 0.8 },
  landuse_residential: { 'fill-color': '#efece6' },
  building: { 'fill-color': '#e7e3db', 'fill-outline-color': '#d8d2c6' },
  highway_minor: { 'line-color': '#ffffff' },
  highway_major_casing: { 'line-color': '#e2ded5' },
  highway_major_inner: { 'line-color': '#ffffff' },
  highway_motorway_casing: { 'line-color': '#e2ded5' },
  highway_motorway_inner: { 'line-color': '#ffffff' },
  highway_motorway_subtle: { 'line-color': '#ffffff' },
};
const HIDE = ['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us'];

/** Neutral slate: stands out on every operator's route colour */
export const STOP = '#4a5264';
const ACCENT = '#1363b8';
/** Searched place marker (matches .place-icon) */
const PLACE = '#d6453a';

// Rail/ferry context layer
const RAIL_FROM = 10; // city scale and closer; zoomed out it's just noise
const minor: Expr = ['==', ['get', 'mode'], 'ets']; // intercity: thinner, fainter
/** Opacity that fades in over 1.5 zoom levels (instead of popping on), scaled by k (dimmed while a bus is shown) */
const fadeIn = (full: Expr, k = 1): Expr => ['interpolate', ['linear'], ['zoom'], RAIL_FROM, 0, RAIL_FROM + 1.5, ['*', full, k]];
export function railOpacity(map: MapLibre, k = 1) {
  map.setPaintProperty('transit-casing', 'line-opacity', fadeIn(0.5, k));
  map.setPaintProperty('transit-line', 'line-opacity', fadeIn(['case', minor, 0.25, 0.55], k));
  map.setPaintProperty('transit-ferry', 'line-opacity', fadeIn(0.4, k));
  map.setPaintProperty('transit-name', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 11, 0, 12, k]);
}

// City areas: the current one is a faint grey tint; other cities are blue, clickable, and light up on hover
const areaHover: Expr = ['boolean', ['feature-state', 'hover'], false];
const isCurrent = (current: string): Expr => ['==', ['get', 'id'], current];
const areaColor = (current: string): Expr => ['case', isCurrent(current), STOP, ACCENT];
const areaFill = (current: string): Record<string, Expr> => ({
  'fill-color': areaColor(current),
  'fill-opacity': ['case', isCurrent(current), 0.035, areaHover, 0.1, 0.02],
});
const areaLineOpacity = (current: string): Expr => ['interpolate', ['linear'], ['zoom'],
  8, ['case', isCurrent(current), 0.55, areaHover, 0.9, 0.3], 15, ['case', isCurrent(current), 0.25, areaHover, 0.9, 0.3]];

/** Mark the current city's area (the expressions compare against its id) */
export function markArea(map: MapLibre, current: string) {
  for (const [k, v] of Object.entries(areaFill(current))) map.setPaintProperty('area-fill', k, v);
  map.setPaintProperty('area-line', 'line-color', areaColor(current));
  map.setPaintProperty('area-line', 'line-opacity', areaLineOpacity(current));
  map.setFilter('area-label', ['!=', ['get', 'id'], current]);
}

/** Chunky direction arrow, SDF so it takes each line's colour */
function arrowIcon() {
  const w = 40, h = 32, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.beginPath();
  g.moveTo(4, 12); g.lineTo(22, 12); g.lineTo(22, 5); g.lineTo(36, 16);
  g.lineTo(22, 27); g.lineTo(22, 20); g.lineTo(4, 20);
  g.closePath(); g.fill();
  return g.getImageData(0, 0, w, h);
}

/** Live bus marker: a dot with a nose pointing up (rotated to the bus's heading), SDF so it takes the route colour */
function busIcon() {
  const size = 44, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.beginPath(); g.arc(22, 25, 12, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(22, 3); g.lineTo(32, 18); g.lineTo(12, 18); g.closePath(); g.fill();
  return g.getImageData(0, 0, size, size);
}

/**
 * The deepest tiles our own map data is cut into; closer in, these are stretched (as the basemap's are, at the same level).
 * MapLibre's default (18) means some 15 small tiles per source in the tilted flyover, each drawn, tracked and, on every
 * data change, rebuilt separately. At 14 a point is still placed to within 30 cm
 */
const TILE_MAX = 14;

export const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

/**
 * Gradient along the line, kept in the route's own hue: colour → lighter tint → colour
 * (line-gradient can't read feature props, so it's set per selection)
 */
export function gradient(hex: string): Expr {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const tint = `hsl(${Math.round((h * 60 + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(Math.min(l + 0.22, 0.75) * 100)}%)`;
  return ['interpolate', ['linear'], ['line-progress'], 0, hex, 0.5, tint, 1, hex];
}

/** Route stop labels: the ends always, the rest from street level */
export const ROUTE_LABELS: Expr = ['any', ['get', 'end'], ['>=', ['zoom'], 15]];

/** Everything the app draws on the basemap. Runs once, when the style has loaded */
export function addLayers(map: MapLibre, regions: RegionMeta[]) {
  const add = (layer: { id: string; type: LayerSpecification['type'] } & Record<string, Expr>, before?: string) =>
    map.addLayer(layer as LayerSpecification, before);

  for (const [layer, paint] of Object.entries(RESTYLE)) {
    if (!map.getLayer(layer)) continue;
    for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(layer, prop, value);
  }
  for (const layer of HIDE) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', 'none');
  add({
    id: 'poi-labels', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 16,
    filter: ['all', ['has', 'name'], ['<=', ['coalesce', ['get', 'rank'], 99], 25]],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-width': 8, 'text-padding': 4 },
    paint: { 'text-color': '#8b8680', 'text-halo-color': '#f4f2ee', 'text-halo-width': 1.4 },
  });

  // Flyover only (hidden until then): 3D buildings under the map's labels, taller = brighter
  add({ id: 'tour-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#15264d', 60, '#2a5cc0', 250, '#6aa5ff'],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.8,
    } }, map.getStyle().layers.find((l) => l.type === 'symbol')?.id);

  map.addImage('route-arrow', arrowIcon(), { sdf: true, pixelRatio: 2 });
  const round = { 'line-cap': 'round', 'line-join': 'round' };

  // Service areas: every city's catchment (500 m walk round its stops). Current city tinted, others a quiet outline you can click
  map.addSource('areas', { type: 'geojson', maxzoom: TILE_MAX, promoteId: 'id', data: fc(regions.map((r) => ({ type: 'Feature', properties: { id: r.id, name: r.name },
    geometry: { type: 'MultiPolygon', coordinates: r.area } }))) });
  add({ id: 'area-fill', type: 'fill', source: 'areas', paint: areaFill('') });
  add({ id: 'area-line', type: 'line', source: 'areas', layout: round,
    paint: { 'line-color': areaColor(''), 'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', areaHover, 2, 1], 14, ['case', areaHover, 2.5, 1.5]],
      'line-opacity': areaLineOpacity('') } });
  // Other cities: one name per city (a polygon label repeats per tile), at its outline's middle
  map.addSource('area-names', { type: 'geojson', maxzoom: TILE_MAX, data: fc(regions.map((r) => {
    const ring = r.area[0][0];
    const mid = [0, 1].map((k) => ring.reduce((sum, c) => sum + c[k], 0) / ring.length);
    return { type: 'Feature', properties: { id: r.id, name: r.name }, geometry: { type: 'Point', coordinates: mid } };
  })) });
  add({ id: 'area-label', type: 'symbol', source: 'area-names', maxzoom: 12, filter: ['!=', ['get', 'id'], ''],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12 },
    paint: { 'text-color': ACCENT, 'text-opacity': 0.75, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

  // Rail + ferry (Apple Maps transit style): official colours on a white casing, stations as white dots with a dark ring.
  // Context only: drawn under the bus layers and never clickable
  map.addSource('transit', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  map.addSource('stations', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  const ferry: Expr = ['==', ['get', 'mode'], 'ferry'];
  const railWidth = (extra: number): Expr => ['interpolate', ['linear'], ['zoom'],
    8, ['+', ['case', minor, 0.5, 0.8], extra], 12, ['+', ['case', minor, 0.8, 1.4], extra], 16, ['+', ['case', minor, 2, 3.5], extra], 19, ['+', ['case', minor, 4, 7], extra]];
  // Shared track: lane s of n, side by side (one line width + a hairline apart)
  const lane: Expr = ['-', ['get', 's'], ['/', ['-', ['get', 'n'], 1], 2]];
  const railOffset: Expr = ['interpolate', ['linear'], ['zoom'], 8, ['*', lane, 1.1], 12, ['*', lane, 1.9], 16, ['*', lane, 4.2], 19, ['*', lane, 8]];
  add({ id: 'transit-casing', type: 'line', source: 'transit', minzoom: RAIL_FROM, filter: ['!', ferry], layout: round,
    paint: { 'line-color': '#ffffff', 'line-width': railWidth(1.5), 'line-offset': railOffset, 'line-opacity': fadeIn(0.5) } });
  add({ id: 'transit-line', type: 'line', source: 'transit', minzoom: RAIL_FROM, filter: ['!', ferry], layout: round,
    paint: { 'line-color': ['get', 'color'], 'line-width': railWidth(0), 'line-offset': railOffset, 'line-opacity': fadeIn(['case', minor, 0.25, 0.55]) } });
  add({ id: 'transit-ferry', type: 'line', source: 'transit', minzoom: RAIL_FROM, filter: ferry, layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#2a8bd6', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 3, 18, 6], 'line-dasharray': [1, 2], 'line-opacity': fadeIn(0.4) } });
  // Line names along the line, in its colour
  add({ id: 'transit-name', type: 'symbol', source: 'transit', minzoom: RAIL_FROM + 1,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 350, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 12], 'text-keep-upright': true, 'text-max-angle': 30 },
    paint: { 'text-color': ['case', ferry, '#2a8bd6', ['get', 'ink']], 'text-halo-color': '#ffffff', 'text-halo-width': 2, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1] } });
  const interchange: Expr = ['>', ['length', ['get', 'lines']], 1];
  add({ id: 'station-dot', type: 'circle', source: 'stations', minzoom: 11,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['case', interchange, 1.8, 1.2], 14, ['case', interchange, 3.5, 2.5], 16, ['case', interchange, 7, 5]],
      'circle-color': '#ffffff', 'circle-stroke-color': '#8a8f9c', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 14, 1.2, 16, 2],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1], 'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 1] } });
  add({ id: 'station-label', type: 'symbol', source: 'stations', minzoom: 13,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['case', interchange, 12, 11],
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.8, 'text-max-width': 9, 'text-optional': true,
      'symbol-sort-key': ['case', interchange, 0, 1] },
    paint: { 'text-color': '#7a8190', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

  // Stops: a plain dot at every zoom (no bus glyph) · 15+ code beside it · 16+ code + name.
  // No special terminus icons: Malaysian route ends aren't SG-style interchanges.
  // MY riders know stops by name (codes aren't on most poles, unlike SG): name leads, code is a small grey hint
  const hasCode: Expr = ['!=', ['coalesce', ['get', 'code'], ''], ''];
  const shortLabel: Expr = ['case', hasCode, ['get', 'code'], ['get', 'name']];
  const nameAndCode: Expr = ['case', hasCode,
    ['format', ['get', 'code'], { 'font-scale': 0.8 }, '\n', {}, ['get', 'name'], { 'text-color': '#2b2f38' }],
    ['format', ['get', 'name'], { 'text-color': '#2b2f38' }]];
  const stopLabel: Expr = ['step', ['zoom'], '', 15, shortLabel, 16, nameAndCode];
  map.addSource('stops', { type: 'geojson', maxzoom: TILE_MAX, tolerance: 10, buffer: 0, data: fc([]) });
  add({ id: 'stops', type: 'circle', source: 'stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 14, 3, 15, 4.5, 18, 7],
      'circle-color': STOP,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, 1, 16, 2],
    } });
  // Labels only (id kept: filters/picking use it)
  add({ id: 'stops-icon', type: 'symbol', source: 'stops', minzoom: 15,
    layout: {
      'text-field': stopLabel,
      'text-font': ['Noto Sans Bold'],
      'text-size': ['step', ['zoom'], 11, 16, 12.5],
      'text-anchor': 'left', 'text-justify': 'left', 'text-offset': [0.8, 0],
      'text-max-width': 14, 'text-line-height': 1.1, 'text-padding': 0.5, 'text-optional': true,
    },
    paint: { 'text-color': STOP, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } });

  // Selection: a service's direction, or all services passing a stop
  map.addSource('sel', { type: 'geojson', maxzoom: TILE_MAX, lineMetrics: true, data: fc([]) });
  // Thin when zoomed out, wider + shifted to the left lane when zoomed in (MY drives on the left)
  const thin: Expr = ['boolean', ['get', 'thin'], false];
  const dim: Expr = ['boolean', ['get', 'dim'], false];
  const routeWidth = (extra: number): Expr => ['interpolate', ['linear'], ['zoom'],
    10, ['+', ['case', thin, 1.5, 2.5], extra],
    12, ['+', ['case', thin, 2, 3], extra],
    16, ['+', ['case', thin, 3.5, 6], extra],
    20, ['+', ['case', thin, 6, 11], extra]];
  const offset: Expr = ['interpolate', ['linear'], ['zoom'], 12, 0, 16, -3, 20, -8];
  // Flyover only: a soft glow under the line as it draws itself
  add({ id: 'tour-glow', type: 'line', source: 'sel', layout: { ...round, visibility: 'none' },
    paint: { 'line-gradient': gradient(STOP), 'line-width': routeWidth(14), 'line-blur': 12, 'line-offset': offset, 'line-opacity': 0.55 } });
  add({ id: 'sel-casing', type: 'line', source: 'sel', layout: round,
    paint: { 'line-color': '#ffffff', 'line-width': routeWidth(3), 'line-offset': offset,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, ['case', dim, 0.4, 0.9], 16, ['case', dim, 0.3, 0.6]] } });
  add({ id: 'sel-line', type: 'line', source: 'sel', layout: round,
    paint: { 'line-color': ['get', 'color'], 'line-gradient': gradient(STOP), 'line-width': routeWidth(0), 'line-offset': offset,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, ['case', dim, 0.25, 0.85], 16, ['case', dim, 0.2, 0.55]] } });
  // Direction arrows beside the line, on the travel (left) side
  add({ id: 'sel-arrows', type: 'symbol', source: 'sel', minzoom: 12,
    filter: ['!', dim],
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 110,
      'icon-image': 'route-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 0.7, 20, 1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
      'icon-offset': ['interpolate', ['linear'], ['zoom'], 12, ['literal', [0, -14]], 16, ['literal', [0, -18]], 20, ['literal', [0, -22]]],
    },
    paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.5 } });

  // Passing routes: bus number written along each line
  add({ id: 'sel-labels', type: 'symbol', source: 'sel',
    filter: ['all', ['has', 'no'], ['!', dim]],
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['get', 'no'],
      'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-padding': 4, 'text-keep-upright': true,
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

  // Stops sit on top of route lines
  for (const id of ['stops', 'stops-icon']) map.moveLayer(id);

  map.addSource('sel-stops', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  add({ id: 'sel-stops-dot', type: 'circle', source: 'sel-stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['get', 'end'], 4, 1.8], 15, ['case', ['get', 'end'], 8, 4.5], 18, ['case', ['get', 'end'], 11, 8]],
      'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['get', 'end'], 2.5, 1.2], 15, ['case', ['get', 'end'], 4, 2.4]],
    } });
  add({ id: 'sel-stops-label', type: 'symbol', source: 'sel-stops',
    filter: ROUTE_LABELS,
    layout: {
      'text-field': ['step', ['zoom'], ['get', 'name'], 16,
        ['case', hasCode, ['format', ['get', 'name'], {}, '\n', {}, ['get', 'code'], { 'font-scale': 0.85, 'text-font': ['literal', ['Noto Sans Regular']], 'text-color': '#7a8190' }], ['get', 'name']]],
      'text-font': ['Noto Sans Bold'], 'text-size': ['case', ['get', 'end'], 13, 11.5], 'text-line-height': 1.15, 'text-letter-spacing': 0.01,
      // Beside the dot, left-aligned, flipping sides to dodge the line/other labels
      'text-variable-anchor': ['left', 'right'], 'text-radial-offset': 0.9, 'text-justify': 'auto',
      'text-max-width': 14, 'text-optional': true, 'text-padding': 3,
      'symbol-sort-key': ['case', ['get', 'end'], 0, 1],
    },
    paint: { 'text-color': '#2b2f38', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 2, 'text-halo-blur': 0.5 } });

  // Flyover only: a pulsing ring, flat on the ground, round the stop the bus is at (white) and, for good, round each stop
  // where you change to rail (the line's colour, with its code)
  add({ id: 'tour-rail-ring', type: 'circle', source: 'sel-stops', filter: ['any', ['has', 'rail'], ['has', 'here']], layout: { visibility: 'none' },
    paint: { 'circle-radius': 24, 'circle-color': ['get', 'ring'], 'circle-opacity': 0.25, 'circle-stroke-color': ['get', 'ring'], 'circle-stroke-width': 4,
      'circle-pitch-alignment': 'map' } }, 'sel-stops-dot');
  add({ id: 'tour-rail-label', type: 'symbol', source: 'sel-stops', filter: ['has', 'rail'],
    layout: { visibility: 'none', 'text-field': ['get', 'rail'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
      'text-anchor': 'bottom', 'text-offset': [0, -1.5], 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': ['get', 'railInk'], 'text-halo-color': ['get', 'railColor'], 'text-halo-width': 3 } });

  // Stop hovered in the sidebar: big ring + name, over everything
  map.addSource('hover-stop', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  add({ id: 'hover-stop', type: 'circle', source: 'hover-stop',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 15, 11, 18, 14], 'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 5] } });
  add({ id: 'hover-stop-label', type: 'symbol', source: 'hover-stop',
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-anchor': 'left', 'text-offset': [1.4, 0],
      'text-max-width': 14, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#2b2f38', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

  // Selected stop: the dot, bigger, white with a thick ring in the bus colour
  map.addSource('pin', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  add({ id: 'pin-halo', type: 'circle', source: 'pin',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 10, 18, 12], 'circle-color': '#ffffff',
      'circle-stroke-color': STOP, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 4.5] } });
  // Own label, pushed past the ring (the regular stop layer skips this stop)
  add({ id: 'pin-icon', type: 'symbol', source: 'pin',
    layout: { 'text-field': ['step', ['zoom'], shortLabel, 16, nameAndCode], 'text-font': ['Noto Sans Bold'],
      'text-size': ['step', ['zoom'], 11, 16, 12.5], 'text-anchor': 'left', 'text-justify': 'left', 'text-offset': [1.3, 0],
      'text-max-width': 14, 'text-line-height': 1.1, 'text-allow-overlap': true },
    paint: { 'text-color': STOP, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } });

  // Searched place: red dot + its name, inside a faint ring of the walk radius
  map.addSource('place', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  // WALK metres in px: 512px tiles → m/px = 40075017·cos(lat) / (512·2^z). cos(~4°) is close enough for MY
  const ringPx = WALK * 512 / (40075017 * Math.cos(4 * Math.PI / 180));
  add({ id: 'place-ring', type: 'circle', source: 'place',
    paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ringPx, 22, ringPx * 2 ** 22],
      'circle-color': PLACE, 'circle-opacity': 0.05, 'circle-stroke-color': PLACE, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.35 } });
  add({ id: 'place-dot', type: 'circle', source: 'place',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 9], 'circle-color': PLACE,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
  add({ id: 'place-label', type: 'symbol', source: 'place',
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-anchor': 'top', 'text-offset': [0, 1],
      'text-max-width': 12, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': PLACE, 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

  // Live buses, on top of everything: marker turned to the heading, route number from street level
  map.addImage('live-bus', busIcon(), { sdf: true, pixelRatio: 2 });
  map.addSource('buses', { type: 'geojson', maxzoom: TILE_MAX, data: fc([]) });
  add({ id: 'buses', type: 'symbol', source: 'buses',
    layout: {
      'icon-image': 'live-bus', 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 1, 17, 1.3],
      'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['step', ['zoom'], '', 13, ['get', 'no']], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
      'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true, 'text-allow-overlap': false,
    },
    paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#ffffff', 'icon-halo-width': 2,
      'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
}
