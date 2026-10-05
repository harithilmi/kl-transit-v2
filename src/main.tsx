import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadRegions } from './lib/data';

const root = createRoot(document.getElementById('root')!);
try {
  const regions = await loadRegions();
  root.render(<StrictMode><App regions={regions} /></StrictMode>);
} catch {
  root.render(<div className="loading glass">Could not load the map data. Reload to try again.</div>);
}
