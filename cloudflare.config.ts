import { bindings, defineConfig, exports, triggers } from 'cf/config';
import * as entrypoint from './worker/index.ts' with { type: 'cf-worker' };

// The audience tag of the Access application that covers the host's paths
// (/api, /agents, /login) on datspace.studio. Editing the existing
// application "patter (datspace.fm)" keeps this tag; a new one has its own.
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
      // Listeners' requests per IP, per Cloudflare location. Namespaces are per account: datspace-ai uses 1001 and 1002.
      LISTEN_LIMIT: bindings.rateLimit({ namespace: '1003', simple: { limit: 120, period: 60 } }),
      // Audio files people bring into patches, by content hash (local dev uses a simulated bucket).
      SAMPLES: bindings.r2({ name: 'patter-samples' }),
      AI_GATEWAY: bindings.text('patter'),
      ACCESS_TEAM: bindings.text('dry-hat-4b71.cloudflareaccess.com'),
      ACCESS_AUD: bindings.text(ACCESS_AUD),
      ALLOWED_EMAILS: bindings.text('jaredcolin@gmail.com'),
      ACCESS_MODE: bindings.text(mode === 'development' ? 'off' : 'on'),
    },
    // datspace.studio is a custom domain of datspace-ai (it serves the other bands); a route here takes
    // precedence over it, so the whole hostname is patter's.
    triggers: [triggers.fetch({ pattern: 'datspace.studio/*', zone: 'datspace.studio' })],
    // Only datspace.studio: no workers.dev or preview URLs, which Access wouldn't cover.
    workersDev: false,
    previewUrls: false,
    // Errors and console output, but no invocation logs: those keep every request's headers,
    // and listeners' requests would bring their IP addresses with them.
    observability: { enabled: true, logs: { invocationLogs: false } },
  },
}));
