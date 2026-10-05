import { useEffect, useRef, useState, type RefObject } from 'react';
import { useApp, useAppState } from './context';

export function CityMenu({ menuOpen }: { menuOpen: RefObject<boolean> }) {
  const app = useApp();
  const regionId = useAppState((s) => s.regionId);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const toggle = (next: boolean) => { menuOpen.current = next; setOpen(next); };

  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.current?.querySelector('button'))?.focus();
    const onPointerDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.city')) toggle(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { toggle(false); button.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...menu.current!.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    addEventListener('pointerdown', onPointerDown);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('pointerdown', onPointerDown); removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="city">
      <button ref={button} className="region" aria-haspopup="listbox" aria-expanded={open} aria-label="City" onClick={() => toggle(!open)}>
        {app.regions.find((r) => r.id === regionId)?.name}
      </button>
      <ul ref={menu} className="city-menu glass" role="listbox" hidden={!open}>
        {app.regions.map((r) => (
          <li key={r.id}>
            <button role="option" aria-selected={r.id === regionId} onClick={() => { toggle(false); app.pickCity(r.id); }}>
              <b>{r.name}</b><span className="tick">✓</span>
              <small>{r.services} buses · {r.operators.join(', ')}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
