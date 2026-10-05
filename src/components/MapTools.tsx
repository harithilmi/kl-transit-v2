import { useState } from 'react';
import { sound } from '../lib/sound';
import { useApp } from './context';

export function MapTools() {
  const app = useApp();
  const [soundOn, setSoundOn] = useState(sound.on);
  return (
    <div className="map-tools">
      <div className="zoom-pair glass">
        <button className="round" aria-label="Zoom in" onClick={app.zoomIn}>+</button>
        <button className="round" aria-label="Zoom out" onClick={app.zoomOut}>−</button>
      </div>
      <button className="round glass sound-btn" aria-label="Sound" aria-pressed={soundOn} onClick={() => setSoundOn(sound.toggle())}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4z" />
          <path className="wave" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          <path className="mute" d="m16 9 6 6m0-6-6 6" />
        </svg>
      </button>
      <button className="round glass" aria-label="Show my location" onClick={app.locate}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </button>
    </div>
  );
}
