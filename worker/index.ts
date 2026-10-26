// patter's Worker: static assets (the instrument itself) are served by the
// platform; this handles /agents/* (the WebSocket to the agent) and /api/*
// (the patch library) — after checking the Cloudflare Access JWT, so only
// allowed identities reach either.

import { routeAgentRequest } from 'agents';
import { verifyAccess } from './access';
import { handleApi } from './api';

export { PatterAgent } from './agent';
export { PatchLibrary } from './library';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const agents = url.pathname.startsWith('/agents/');
    const api = url.pathname.startsWith('/api/');
    if (!agents && !api) return new Response('Not found', { status: 404 });

    // In local development there is no Access in front; everything is 'dev'.
    let user = 'dev';
    if (env.ACCESS_MODE !== 'off') {
      const email = await verifyAccess(request, {
        team: env.ACCESS_TEAM,
        aud: env.ACCESS_AUD,
        allowed: env.ALLOWED_EMAILS.split(',').map((s) => s.trim()).filter(Boolean),
      });
      if (!email) return new Response('Forbidden: sign in through Cloudflare Access', { status: 403 });
      user = email;
    }

    if (api) return handleApi(request, env, user);
    return (await routeAgentRequest(request, env)) ?? new Response('No such agent', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
