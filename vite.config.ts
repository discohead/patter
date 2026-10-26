import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SuperSonic's SAB transport needs a cross-origin isolated page. In production
// public/_headers sets the same two headers on every asset.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 5317, headers: isolation },
  preview: { port: 5317, headers: isolation },
  optimizeDeps: { exclude: ['supersonic-scsynth'] },
  build: { target: 'es2022' },
});
