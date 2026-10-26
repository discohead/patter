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
    // The instrument is static; only the agent WebSocket and the patch library run the Worker.
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/agents/*', '/api/*'] },
    exports: {
      PatterAgent: exports.durableObject({ storage: 'sqlite' }),
      PatchLibrary: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      // Workers AI only runs on Cloudflare, so local dev reaches the real thing.
      AI: bindings.ai({ dev: { remote: true } }),
      PatterAgent: bindings.durableObject({ worker: 'patter', exportName: 'PatterAgent' }),
      PatchLibrary: bindings.durableObject({ worker: 'patter', exportName: 'PatchLibrary' }),
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
