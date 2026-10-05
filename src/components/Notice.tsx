import { useAppState } from './context';

/** The pill at the top: "Loading…" while a city downloads */
export function Notice() {
  const notice = useAppState((s) => s.notice);
  return <div className="loading glass" hidden={!notice}>{notice}</div>;
}
