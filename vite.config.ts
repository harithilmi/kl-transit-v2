import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative links: the app runs from any folder (GitHub Pages serves it from /kl-transit-v2/)
  plugins: [react()],
  server: { port: 8765 },
  preview: { port: 8765 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1100,
    // The map library in its own file: it stays in the browser's cache when only the app changes
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ }] } } },
  },
});
