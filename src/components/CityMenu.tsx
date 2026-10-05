import { useEffect, useRef, type RefObject } from 'react';
import { useApp, useAppState } from './context';

/** The current city, in the panel's header: opens and closes the list of cities */
export function CityButton({ ref, open, toggle }: { ref: RefObject<HTMLButtonElement | null>; open: boolean; toggle: (open: boolean) => void }) {
  const app = useApp();
  const regionId = useAppState((s) => s.regionId);
  return (
    <button ref={ref} className="region" aria-haspopup="listbox" aria-expanded={open} aria-label="City" onClick={() => toggle(!open)}>
      {app.regions.find((r) => r.id === regionId)?.name}
    </button>
  );
}

/**
 * The cities, in the panel's own list (in place of the buses) while one is being picked: it scrolls like every other
 * list here, however many cities there are and however short the panel is (a phone's bottom sheet)
 */
export function CityList({ button, toggle }: { button: RefObject<HTMLButtonElement | null>; toggle: (open: boolean) => void }) {
  const app = useApp();
  const regionId = useAppState((s) => s.regionId);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { toggle(false); button.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...list.current!.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [button, toggle]);

  return (
    <div ref={list} role="listbox" aria-label="City">
      <h3 className="section-title">{app.regions.length} cities</h3>
      {app.regions.map((r) => (
        <button key={r.id} className="row city" role="option" aria-selected={r.id === regionId} onClick={() => { toggle(false); app.pickCity(r.id); }}>
          <div className="main">
            <div className="t">{r.name}</div>
            <div className="s">{r.services} buses · {r.operators.join(', ')}</div>
          </div>
          <span className="tick">✓</span>
        </button>
      ))}
    </div>
  );
}
