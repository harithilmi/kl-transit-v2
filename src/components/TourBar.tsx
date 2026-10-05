import { useMemo } from 'react';
import { railNear } from '../lib/rail';
import { Badge, Badges, RailList } from './chips';
import { useApp, useAppState } from './context';

/** Flyover: the map goes dark and full-screen; only this bar stays */
export function TourBar() {
  const app = useApp();
  const tour = useAppState((s) => s.tour);
  const data = useAppState((s) => s.data);
  const transit = useAppState((s) => s.transit);
  const stop = tour?.stop;
  const svc = tour?.svc;
  // Change here: rail (station + walk) first, then a few of the other buses
  const change = useMemo(() => (data && stop !== undefined && (
    <>
      <RailList rail={railNear(transit, data.region, stop)} />
      <Badges data={data} svcs={data.stopServices[stop].filter((o) => o !== svc).slice(0, 8)} />
    </>
  )), [data, transit, stop, svc]);

  return (
    <div className="tour glass" id="tour" hidden={!tour} ref={app.setHud}>
      <span>{tour && data && <Badge region={data.region} svc={data.region.services[tour.svc]} />}</span>
      <div className="main">
        <div className="t">{tour && data?.region.stops[tour.stop][2]}</div>
        <div className="s">{tour && `Stop ${tour.shown} of ${tour.total}${tour.mins ? ` · ${tour.mins} min` : ''} · to ${tour.to}`}</div>
        <div id="tour-change">{change || null}</div>
      </div>
      <div className="keys">
        <button className="chip-btn" aria-label="Previous stop" title="Previous stop (←)" onClick={() => app.pressTour('prev')}>‹</button>
        <button className="chip-btn" aria-label={tour?.paused ? 'Play' : 'Pause'} title="Pause (space)" onClick={() => app.pressTour('pause')}>{tour?.paused ? '▶︎' : '❚❚'}</button>
        <button className="chip-btn" aria-label="Next stop" title="Next stop (→)" onClick={() => app.pressTour('next')}>›</button>
        <button className="chip-btn" aria-label="Speed" title="Speed" onClick={() => app.pressTour('rate')}>{tour?.rate ?? 1}×</button>
        <button className="chip-btn" title="End flyover (Esc)" onClick={() => app.pressTour('end')}>End</button>
      </div>
    </div>
  );
}
