import { tipStore } from '../app/state';
import { useStore } from '../lib/store';

/** The label that follows the pointer over the map: a stop's name, a bus's number, a city to switch to */
export function Tip() {
  const tip = useStore(tipStore, (t) => t);
  return (
    <div className={tip.show ? 'tip show' : 'tip'} style={{ left: tip.x, top: tip.y }}>
      {tip.tag && <span className="tag">{tip.tag}</span>}
      {tip.text}
    </div>
  );
}
