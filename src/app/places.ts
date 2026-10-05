import type { Place, RegionMeta } from '../types';
import { store, type PlaceSearch } from './state';

// Place search (local Nominatim)
const NOMINATIM = import.meta.env.VITE_NOMINATIM_URL ?? 'http://localhost:8088/search';

interface NominatimHit { lat: string; lon: string; name: string; display_name: string; category: string; type: string }

/** OSM's bus stops (our stop search covers them) and train stop positions (the station itself is kept) bury real places */
const isBusStop = (h: NominatimHit) => (h.category === 'highway' && h.type === 'bus_stop')
  || (h.category === 'railway' && h.type === 'stop')
  || (h.category === 'public_transport' && (h.type === 'platform' || h.type === 'stop_position'));

/** Nominatim hit → Place: its name plus a short "street, area" line */
function toPlace(h: NominatimHit): Place {
  const parts = h.display_name.split(', ').filter((p) => p !== 'Malaysia' && !/^\d{5}$/.test(p));
  const name = h.name || parts[0];
  return { name, detail: parts.filter((p) => p !== name).slice(0, 3).join(', '), lng: +h.lon, lat: +h.lat };
}

export function createPlaceSearch(regions: RegionMeta[]) {
  let ctl = new AbortController(), timer = 0;
  let downUntil = 0; // server off: back off for a while instead of retrying every keystroke
  const set = (patch: Partial<PlaceSearch>) => store.set({ places: { ...store.get().places, ...patch } });

  /** Debounced lookup; each keystroke cancels the previous request */
  function search(term: string) {
    clearTimeout(timer);
    ctl.abort();
    const { places } = store.get();
    if (term.length < 3) return set({ term: '', hits: [], status: 'idle' });
    if (term === places.term && places.status === 'ok') return;
    if (Date.now() < downUntil) return set({ hits: [], status: 'down' });
    // The last results stay up while this query loads, so the list doesn't flicker per keystroke
    set({ status: 'loading' });
    const mine = (ctl = new AbortController());
    timer = window.setTimeout(async () => {
      // Bias (not limit) to the current city: other places still show up, just ranked lower
      const [w, s, e, n] = (regions.find((r) => r.id === store.get().regionId) ?? regions[0]).bounds;
      const params = new URLSearchParams({ q: term, format: 'jsonv2', countrycodes: 'my', limit: '12', viewbox: `${w},${n},${e},${s}`, 'accept-language': 'en' });
      try {
        const res = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.any([mine.signal, AbortSignal.timeout(5000)]) });
        if (!res.ok) throw new Error(`Nominatim ${res.status}`);
        const hits: NominatimHit[] = await res.json();
        if (mine.signal.aborted) return;
        set({ term, hits: hits.filter((h) => !isBusStop(h)).slice(0, 6).map(toPlace), status: 'ok' });
      } catch {
        if (mine.signal.aborted) return; // a newer keystroke took over
        downUntil = Date.now() + 30_000;
        set({ term, hits: [], status: 'down' });
      }
    }, 300);
  }

  return { search, destroy() { clearTimeout(timer); ctl.abort(); } };
}
