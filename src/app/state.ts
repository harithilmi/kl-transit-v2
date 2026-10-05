import type { RegionIndex } from '../lib/data';
import { createStore } from '../lib/store';
import type { Place, Transit, View } from '../types';

/** Latest place results. `down` = server off or still importing */
export interface PlaceSearch { term: string; hits: Place[]; status: 'idle' | 'loading' | 'ok' | 'down' }

/** What the flyover bar shows */
export interface TourHud { svc: number; stop: number; shown: number; total: number; mins: number | undefined; to: string; paused: boolean; rate: number }

export interface AppState {
  regionId: string;
  data: RegionIndex | null;
  view: View;
  /** Stop view: "Show all passing routes" toggled on */
  showAll: boolean;
  transit: Transit | null;
  /** The search box */
  query: string;
  places: PlaceSearch;
  /** Stop view: the bus singled out by hover or a first tap */
  highlighted: number;
  /** Text of the pill at the top ("Loading…"), or null when there is none */
  notice: string | null;
  tour: TourHud | null;
}

export const initialState = (regionId: string): AppState => ({
  regionId,
  data: null,
  view: { kind: 'home' },
  showAll: false,
  transit: null,
  query: '',
  places: { term: '', hits: [], status: 'idle' },
  highlighted: -1,
  notice: null,
  tour: null,
});

export const store = createStore<AppState>(initialState(''));

/** The label that follows the pointer over the map. Its own store: it changes on every mouse move */
export const tipStore = createStore({ show: false, tag: '', text: '', x: 0, y: 0 });
