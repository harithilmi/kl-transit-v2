import { memo, useMemo } from 'react';
import { colorOf, type RegionIndex } from '../lib/data';
import { railNear } from '../lib/rail';
import { clock, ended, headway, viaOf } from '../lib/timetable';
import { Badge, tone, Transfers } from './chips';
import { useApp, useAppState } from './context';

/** A bus: its directions, first and last bus, and every stop with the transfers there */
export const ServiceView = memo(function ServiceView({ data, svc: svcIdx, dir }: { data: RegionIndex; svc: number; dir: number }) {
  const app = useApp();
  const transit = useAppState((s) => s.transit);
  const { region, stopServices } = data;
  const svc = region.services[svcIdx];
  const p = svc.patterns[dir];
  const every = headway(p);

  const rows = useMemo(() => p.stops.map((s, k) => {
    const st = region.stops[s];
    return (
      <li key={k} className={k === 0 || k === p.stops.length - 1 ? 'end' : undefined}>
        <button className="row" data-stop={s} onClick={() => app.openStop(s)}>
          <div className="main">
            <div className="t">{st[2]}{st[3] && <> <span className="code">{st[3]}</span></>}</div>
            <Transfers data={data} rail={railNear(transit, region, s)} svcs={stopServices[s].filter((o) => o !== svcIdx)} />
          </div>
        </button>
      </li>
    );
  }), [app, data, p, region, stopServices, svcIdx, transit]);

  return (
    <>
      <div className="detail-head">
        <button className="close-x" aria-label="Close" onClick={app.back}>✕</button>
        <div className="title-row">
          <Badge region={region} svc={svc} size="lg" />
          <div><h2>{svc.name}</h2><div className="op">{region.operators[svc.op].name}</div></div>
        </div>
        {/* One direction: the title already says where it goes */}
        {svc.patterns.length > 1 && (
          <div className="dirs">
            {svc.patterns.map((pt, d) => (
              <button key={d} className={d === dir ? 'active' : undefined} onClick={() => app.setDirection(d)}>
                <span>{pt.loop ? 'Loop via' : 'To'} <b>{pt.to}</b>{pt.loop ? '' : viaOf(svc)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="facts">
          <div className="fact"><b>{clock(p.first)}</b><span>First bus</span></div>
          <div className="fact"><b>{clock(p.last)}</b><span>Last bus</span></div>
          <div className="fact"><b>{every ? `~${every} min` : '—'}</b><span>Every</span></div>
        </div>
        {ended(p) && <div className="note"><span className="off ended">Ended for today</span></div>}
        <div className="toggle-row">
          <div className="note">{p.stops.length} stops{p.mins ? ` · ~${p.mins[p.mins.length - 1]} min end to end` : ''}</div>
          <button className="chip-btn" onClick={app.startTour}>{'▶︎ Fly along'}</button>
        </div>
      </div>
      <ol className="timeline" style={tone(colorOf(region, svc))}>{rows}</ol>
    </>
  );
});
