import { createContext, useContext } from 'react';
import type { AppState } from '../app/state';
import { store } from '../app/state';
import type { Controller } from '../app/controller';
import { useStore } from '../lib/store';

export const AppContext = createContext<Controller | null>(null);

/** The map's actions */
export const useApp = () => useContext(AppContext)!;

/** One part of the app's state; the component re-renders when that part changes */
export const useAppState = <S,>(select: (state: AppState) => S) => useStore(store, select);
