import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createController, type Controller } from './app/controller';
import { store } from './app/state';
import { AppContext } from './components/context';
import { MapTools } from './components/MapTools';
import { Notice } from './components/Notice';
import { Panel } from './components/Panel';
import { Tip } from './components/Tip';
import { TourBar } from './components/TourBar';
import type { RegionMeta } from './types';

export function App({ regions }: { regions: RegionMeta[] }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<Controller | null>(null);

  // The map lives outside React: made once the page has its box, and removed with it
  useLayoutEffect(() => {
    const controller = createController(mapEl.current!, regions);
    setApp(controller);
    return () => controller.destroy();
  }, [regions]);

  // Keys for the whole page: "/" jumps to search · Esc closes the open bus/stop (like its ✕) · the flyover's keys
  const search = useRef<HTMLInputElement>(null);
  const menuOpen = useRef(false);
  useEffect(() => {
    if (!app) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea');
      if (typing || menuOpen.current || e.metaKey || e.ctrlKey || e.altKey) return;
      if (store.get().tour) {
        const key = ({ Escape: 'end', ' ': 'pause', ArrowLeft: 'prev', ArrowRight: 'next' } as const)[e.key];
        if (key) { e.preventDefault(); app.pressTour(key); }
        return;
      }
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'Escape' && store.get().view.kind !== 'home') app.back();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [app]);

  return (
    <>
      <div id="map" ref={mapEl} role="application" aria-label="Bus route map" />
      {app && (
        <AppContext value={app}>
          <MapTools />
          <Panel search={search} menuOpen={menuOpen} />
          <Tip />
          <TourBar />
          <Notice />
        </AppContext>
      )}
    </>
  );
}
