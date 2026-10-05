import { memo, useMemo } from 'react';
import type { RegionIndex } from '../lib/data';
import { railNear } from '../lib/rail';
import { headway, viaOf } from '../lib/timetable';
import { Badge, RailList } from './chips';
import { useApp, useAppState } from './context';

/** A stop: the rail lines a short walk away, and every bus that stops here */
export const StopView = memo(function StopView({ data, stop }: { data: RegionIndex; stop: number }) {
  const app = useApp();
  const transit = useAppState((s) => s.transit);
  const showAll = useAppState((s) => s.showAll);
  const highlighted = useAppState((s) => s.highlighted);
  const { region } = data;
  const st = region.stops[stop];
  const passing = data.stopServices[stop];
  const rail = useMemo(() => railNear(transit, region, stop), [transit, region, stop]);

  const rows = useMemo(() => passing.map((svcIdx) => {
    const svc = region.services[svcIdx];
    // Directions that serve this stop (not as their last stop)
    const dirs = svc.patterns.map((p, d) => ({ p, d, k: p.stops.indexOf(stop) })).filter(({ p, k }) => k >= 0 && k < p.stops.length - 1);
    const main = dirs[0] ?? { p: svc.patterns[0], d: 0 };
    const to = dirs.length ? dirs.map(({ p }) => `${p.loop ? 'Loop via' : 'To'} ${p.to}${p.loop ? '' : viaOf(svc)}`).join(' · ') : 'Ends here';
    return { svcIdx, svc, dir: main.d, to, every: headway(main.p) };
  }), [passing, region, stop]);

  return (
    <>
      <div className="detail-head">
        <button className="close-x" aria-label="Close" onClick={app.back}>✕</button>
        <div className="title-row">
          <div><h2>{st[2]}</h2>{st[3] && <div className="op"><span className="code-tag">{st[3]}</span></div>}</div>
        </div>
        <RailList rail={rail} />
        {passing.length > 0 && (
          <button className="chip-btn" aria-pressed={showAll} onClick={app.togglePassing}>{showAll ? 'Hide' : 'Show all'} passing routes</button>
        )}
      </div>
      {rows.length ? rows.map(({ svcIdx, svc, dir, to, every }) => (
        <button key={svcIdx} className={svcIdx === highlighted ? 'row hl' : 'row'} data-svc={svcIdx} onClick={() => app.openService(svcIdx, dir)}>
          <Badge region={region} svc={svc} />
          <div className="main"><div className="t wrap">{to}</div></div>
          {every && <span className="every">every {every} min</span>}
        </button>
      )) : <div className="empty">No buses</div>}
    </>
  );
});
