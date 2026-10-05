import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { CityButton, CityList } from './CityMenu';
import { useApp, useAppState } from './context';
import { Home } from './Home';
import { PlaceView } from './PlaceView';
import { ServiceView } from './ServiceView';
import { StopView } from './StopView';

const numberOn = (el: HTMLElement, key: 'stop' | 'svc') => {
  const value = el.closest<HTMLElement>(`[data-${key}]`)?.dataset[key];
  return value === undefined ? -1 : +value;
};

interface Props {
  /** The search box, so "/" can jump to it */
  search: RefObject<HTMLInputElement | null>;
  /** Whether the city list is open: the page's keys leave it alone while it is */
  menuOpen: RefObject<boolean>;
}

export function Panel({ search, menuOpen }: Props) {
  const app = useApp();
  const data = useAppState((s) => s.data);
  const view = useAppState((s) => s.view);
  const query = useAppState((s) => s.query);
  // Typing stays quick: the list catches up a moment after the box
  const listed = useDeferredValue(query);
  const body = useRef<HTMLDivElement>(null);

  // Picking a city: the list of cities takes the panel's body until one is picked, or something else is opened or searched
  const [cities, setCities] = useState(false);
  const cityButton = useRef<HTMLButtonElement>(null);
  const showCities = useCallback((open: boolean) => { menuOpen.current = open; setCities(open); }, [menuOpen]);
  useEffect(() => showCities(false), [view, query, showCities]);

  // Each new view (and each search) starts at the top
  useLayoutEffect(() => { body.current!.scrollTop = 0; }, [view, listed, data, cities]);

  // One listener for the whole list: rows carry their stop or bus in data-stop / data-svc
  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const el = e.target as HTMLElement;
    app.hoverRow(numberOn(el, 'stop'), numberOn(el, 'svc'));
  };

  return (
    <aside className="panel glass" id="panel">
      <div className="head">
        <div className="brand">
          <h1>KL <span>Transit</span></h1>
          <CityButton ref={cityButton} open={cities} toggle={showCities} />
        </div>
        <label className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input
            ref={search} id="q" type="search" placeholder="Bus number or stop" autoComplete="off" spellCheck={false} enterKeyHint="search"
            value={query}
            onFocus={() => showCities(false)}
            onChange={(e) => app.setQuery(e.target.value)}
            // Enter opens the top result · Esc clears, then leaves the box
            onKeyDown={(e) => {
              if (e.key === 'Enter') body.current?.querySelector<HTMLElement>('.row')?.click();
              if (e.key === 'Escape') { if (query) app.clearQuery(); else e.currentTarget.blur(); }
            }}
          />
          <button type="button" className="clear" aria-label="Clear search" hidden={!query} onClick={() => { app.clearQuery(); search.current?.focus(); }}>✕</button>
        </label>
      </div>
      <div className="body" ref={body} onPointerOver={onPointerOver} onPointerLeave={app.leaveRows}>
        {cities ? <CityList button={cityButton} toggle={showCities} /> : data && (
          view.kind === 'service' ? <ServiceView data={data} svc={view.svc} dir={view.dir} />
          : view.kind === 'stop' ? <StopView data={data} stop={view.stop} />
          : view.kind === 'place' ? <PlaceView data={data} place={view.place} />
          : <Home data={data} query={listed} />
        )}
      </div>
    </aside>
  );
}
