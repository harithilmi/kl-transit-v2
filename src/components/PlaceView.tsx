import { memo, useMemo } from 'react';
import type { RegionIndex } from '../lib/data';
import { distance, nearStops, WALK } from '../lib/geo';
import type { Place } from '../types';
import { Badges } from './chips';
import { useApp } from './context';

/** A searched place: the stops within a walk of it, nearest first */
export const PlaceView = memo(function PlaceView({ data, place }: { data: RegionIndex; place: Place }) {
  const app = useApp();
  const { region, stopServices } = data;
  const near = useMemo(() => nearStops(region, place), [region, place]);
  const walkable = near.filter(({ d }) => d <= WALK).length;

  return (
    <>
      <div className="detail-head">
        <button className="close-x" aria-label="Close" onClick={app.back}>✕</button>
        <div className="title-row">
          <span className="place-icon" style={{ width: 34, height: 34 }} />
          <div><h2>{place.name}</h2>{place.detail && <div className="op">{place.detail}</div>}</div>
        </div>
        {!walkable && <div className="note">No bus stops within {WALK} m. Nearest one:</div>}
      </div>
      <h3 className="section-title">{walkable ? `${walkable} stop${walkable === 1 ? '' : 's'} within ${WALK} m` : 'Nearest stop'}</h3>
      {near.map(({ i, d }) => {
        const st = region.stops[i];
        return (
          <button key={i} className="row near" data-stop={i} onClick={() => app.openStop(i)}>
            <span className="stop-icon" />
            <div className="main">
              <div className="t">{st[2]}</div>
              {st[3] && <div className="s"><span className="code">{st[3]}</span></div>}
              <Badges data={data} svcs={stopServices[i]} />
            </div>
            <span className="dist">{distance(d)}</span>
          </button>
        );
      })}
    </>
  );
});
