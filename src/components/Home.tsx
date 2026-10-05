import { memo, useMemo } from 'react';
import type { RegionIndex } from '../lib/data';
import { regionAt } from '../lib/geo';
import type { Region, Service, Stop } from '../types';
import { Badge } from './chips';
import { useApp, useAppState } from './context';

const ServiceRow = memo(function ServiceRow({ region, svc, i, open }: { region: Region; svc: Service; i: number; open: (svc: number) => void }) {
  return (
    <button className="row" data-svc={i} onClick={() => open(i)}>
      <Badge region={region} svc={svc} />
      <div className="main"><div className="t wrap">{svc.name}</div></div>
    </button>
  );
});

const StopRow = memo(function StopRow({ stop, i, open }: { stop: Stop; i: number; open: (stop: number) => void }) {
  return (
    <button className="row" data-stop={i} onClick={() => open(i)}>
      <span className="stop-icon" />
      <div className="main">
        <div className="t">{stop[2]}</div>
        {stop[3] && <div className="s"><span className="code">{stop[3]}</span></div>}
      </div>
    </button>
  );
});

/** The city's buses, or what the search box finds: stops, buses and places */
export const Home = memo(function Home({ data, query }: { data: RegionIndex; query: string }) {
  const app = useApp();
  const places = useAppState((s) => s.places);
  const regionId = useAppState((s) => s.regionId);
  const { region } = data;
  const term = query.trim().toLowerCase();

  // What the search looks through, in lower case (once per city, not per keystroke)
  const lower = useMemo(() => ({
    services: region.services.map((svc) => ({ no: svc.no.toLowerCase(), name: svc.name.toLowerCase() })),
    stops: region.stops.map((s) => ({ name: s[2].toLowerCase(), code: s[3].toLowerCase() })),
  }), [region]);

  const services = useMemo(() => {
    const all = region.services.map((svc, i) => ({ svc, i }));
    if (!term) return all;
    // Numbers that start with the search come first
    return all
      .filter(({ i }) => lower.services[i].no.includes(term) || lower.services[i].name.includes(term))
      .sort((a, b) => Number(!lower.services[a.i].no.startsWith(term)) - Number(!lower.services[b.i].no.startsWith(term)));
  }, [region, lower, term]);

  const stops = useMemo(() => {
    const found: number[] = [];
    if (term.length < 2) return found;
    for (let i = 0; i < lower.stops.length && found.length < 60; i++) {
      if (lower.stops[i].name.includes(term) || lower.stops[i].code.startsWith(term)) found.push(i);
    }
    return found;
  }, [lower, term]);

  // Places: last results stay up while the next query loads, so the list doesn't flicker per keystroke
  const hits = term.length >= 3 ? places.hits : [];
  // Legend only when riders would see different brands
  const brands = useMemo(() => [...new Map(region.operators.map((o) => [o.name, o])).values()], [region]);

  return (
    <>
      {stops.length > 0 && <>
        <h3 className="section-title">Stops</h3>
        {stops.map((i) => <StopRow key={i} stop={region.stops[i]} i={i} open={app.openStop} />)}
      </>}
      {services.length > 0 && <>
        <h3 className="section-title">
          {term ? 'Buses' : `${services.length} buses`}
          {brands.length > 1 && brands.map((o) => <span key={o.name} className="op-key"><i style={{ background: o.color }} />{o.name}</span>)}
        </h3>
        {services.map(({ svc, i }) => <ServiceRow key={i} region={region} svc={svc} i={i} open={app.openService} />)}
      </>}
      {hits.length > 0 && <>
        <h3 className="section-title">Places</h3>
        {hits.map((p, k) => {
          const city = regionAt(app.regions, regionId, p);
          return (
            <button key={k} className="row" onClick={() => app.openPlace(p)}>
              <span className="place-icon" />
              <div className="main">
                <div className="t">{p.name}</div>
                <div className="s">{city && city.id !== regionId ? `${city.name} · ` : ''}{p.detail}</div>
              </div>
            </button>
          );
        })}
      </>}
      {!services.length && !stops.length && !hits.length && (
        term.length >= 3 && places.status === 'loading'
          ? <div className="empty">Searching places…</div>
          : <div className="empty">Nothing matches “{query}”{places.status === 'down' && <div className="note">Place search unavailable</div>}</div>
      )}
    </>
  );
});
