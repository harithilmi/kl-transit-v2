import type { Pattern, Service } from '../types';

export const clock = (t: string | null) => (t ? `${t.slice(0, 2)}:${t.slice(2)}` : '—');
const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(2);

/** " via Juaseh" from the route name: tells apart buses with the same ends (N10A/N10B) */
export const viaOf = (svc: Service) => svc.name.match(/ via .+$/i)?.[0] ?? '';

/** Weekday timetable only: "Starts 06:00" / "Ended for today", or '' while running (and on weekends) */
export function runningNote(p: Pattern) {
  const d = new Date();
  if (!p.first || !p.last || d.getDay() === 0 || d.getDay() === 6) return '';
  const now = d.getHours() * 60 + d.getMinutes(), first = toMin(p.first);
  let last = toMin(p.last);
  if (last < first) last += 1440; // runs past midnight
  if (now < first && now + 1440 > last) return `Starts ${clock(p.first)}`;
  if (now > last) return 'Ended for today';
  return '';
}

/** Average gap between departures, in minutes */
export function headway(p: Pattern) {
  if (!p.first || !p.last || p.trips < 2) return null;
  let span = toMin(p.last) - toMin(p.first);
  if (span <= 0) span += 1440;
  return Math.round(span / (p.trips - 1));
}
