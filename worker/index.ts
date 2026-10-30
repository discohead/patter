// patter's Worker: static assets (the instrument itself) are served by the
// platform. This handles the public side (/whoami, and /listen: the
// broadcast) for anyone, and /agents/* (the WebSocket to the agent) and
// /api/* (the patch library, and going on air) only after checking the
// Cloudflare Access JWT, so only allowed identities reach the model or the library.

import { routeAgentRequest } from 'agents';
import { hostOf } from './access';
import { handleApi } from './api';
import { handlePublic, isPublic } from './listen';

export { PatterAgent } from './agent';
export { PatchLibrary } from './library';
export { OnAir } from './on-air';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isPublic(url.pathname)) return handlePublic(request, env);
    const agents = url.pathname.startsWith('/agents/');
    const api = url.pathname.startsWith('/api/');
    if (!agents && !api) return new Response('Not found', { status: 404 });

    // In local development there is no Access in front; everyone is 'dev'.
    const user = await hostOf(request, env);
    if (!user) return new Response('Forbidden: sign in through Cloudflare Access', { status: 403 });

    if (api) return handleApi(request, env, user);
    return (await routeAgentRequest(request, env)) ?? new Response('No such agent', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
