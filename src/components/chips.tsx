import { Fragment, memo, type CSSProperties } from 'react';
import { colorOf, type RegionIndex } from '../lib/data';
import { distance } from '../lib/geo';
import { chipColor, inkOn, railCode, type RailNear } from '../lib/rail';
import type { Region, Service, TransitLine } from '../types';

/** `--c` is the colour the badge and the timeline are drawn in */
export const tone = (color: string, ink?: string) => ({ '--c': color, color: ink }) as CSSProperties;

/** Service number badge, in the route's colour */
export const Badge = memo(function Badge({ region, svc, size }: { region: Region; svc: Service; size?: 'sm' | 'lg' }) {
  return <span className={size ? `badge ${size}` : 'badge'} style={tone(colorOf(region, svc))}>{svc.no}</span>;
});

/** Small badges for a list of services, all of them (they wrap) */
export function Badges({ data, svcs }: { data: RegionIndex; svcs: number[] }) {
  if (!svcs.length) return null;
  return <div className="others">{svcs.map((s) => <Badge key={s} region={data.region} svc={data.region.services[s]} size="sm" />)}</div>;
}

/** Rail transfer: same shape as a small bus badge, in the line's official colour */
export function RailChip({ line, title }: { line: TransitLine; title?: string }) {
  const color = chipColor(line);
  return <span className="rail" style={tone(color, inkOn(color))} title={title}>{railCode(line)}</span>;
}

/** Transfers at a stop on a route: rail first, then other buses */
export function Transfers({ data, rail, svcs }: { data: RegionIndex; rail: RailNear[]; svcs: number[] }) {
  if (!rail.length) return <Badges data={data} svcs={svcs} />;
  return (
    <div className="others">
      {rail.map(({ line, station, d }) => <RailChip key={railCode(line)} line={line} title={`${line.name} · ${station} · ${distance(d)}`} />)}
      {svcs.map((s) => <Badge key={s} region={data.region} svc={data.region.services[s]} size="sm" />)}
    </div>
  );
}

/** Each nearby line with its station and walk */
export function RailList({ rail }: { rail: RailNear[] }) {
  if (!rail.length) return null;
  const byStation = new Map<string, RailNear[]>();
  for (const r of rail) byStation.set(r.station, [...(byStation.get(r.station) ?? []), r]);
  return (
    <div className="rail-list">
      {[...byStation].map(([station, lines]) => (
        <div key={station}>
          {lines.map(({ line }) => <Fragment key={railCode(line)}><RailChip line={line} />{' '}</Fragment>)}
          {station} <span className="s">· {distance(lines[0].d)} walk</span>
        </div>
      ))}
    </div>
  );
}
