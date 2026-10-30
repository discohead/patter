import { bindings, defineConfig, exports, triggers } from 'cf/config';
import * as entrypoint from './worker/index.ts' with { type: 'cf-worker' };

// The audience tag of the Access application "patter (datspace.fm)".
const ACCESS_AUD = '1a336f716d224a5e94fe26f649ccf2736bdba3328fa6807f060628d598e420a6';

export default defineConfig(({ mode }) => ({
  accountId: '95172b58dda92702d7e2a6cad25b3e26',
  worker: {
    name: 'patter',
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    // The instrument is static. The Worker runs for the agent's WebSocket and the library (the host's),
    // and for who's asking and the broadcast (anyone's).
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/agents/*', '/api/*', '/whoami', '/login', '/listen', '/listen/*'],
    },
    exports: {
      PatterAgent: exports.durableObject({ storage: 'sqlite' }),
      PatchLibrary: exports.durableObject({ storage: 'sqlite' }),
      OnAir: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      // Workers AI only runs on Cloudflare, so local dev reaches the real thing.
      AI: bindings.ai({ dev: { remote: true } }),
      PatterAgent: bindings.durableObject({ worker: 'patter', exportName: 'PatterAgent' }),
      PatchLibrary: bindings.durableObject({ worker: 'patter', exportName: 'PatchLibrary' }),
      // The broadcast: what's on air, and the listeners' WebSockets.
      OnAir: bindings.durableObject({ worker: 'patter', exportName: 'OnAir' }),
      // Listeners' requests per IP, per Cloudflare location (datspace-ai's limiter is namespace 1001).
      LISTEN_LIMIT: bindings.rateLimit({ namespace: '1002', simple: { limit: 120, period: 60 } }),
      // Audio files people bring into patches, by content hash (local dev uses a simulated bucket).
      SAMPLES: bindings.r2({ name: 'patter-samples' }),
      AI_GATEWAY: bindings.text('patter'),
      ACCESS_TEAM: bindings.text('dry-hat-4b71.cloudflareaccess.com'),
      ACCESS_AUD: bindings.text(ACCESS_AUD),
      ALLOWED_EMAILS: bindings.text('jaredcolin@gmail.com'),
      ACCESS_MODE: bindings.text(mode === 'development' ? 'off' : 'on'),
    },
    triggers: [triggers.fetch({ pattern: 'datspace.fm/*', zone: 'datspace.fm' })],
    // Only datspace.fm (behind Access): no workers.dev or preview URLs that could bypass it.
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true },
  },
}));
