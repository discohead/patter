// Cloudflare Access, checked again inside the Worker: the hostname's Access
// application covers the host's paths (/api, /agents, /login) and lets only
// the allowed identities through, and the Worker refuses any of those
// requests that doesn't carry a valid Access JWT for that application — so
// nothing else that might reach the Worker can use them. The same check
// answers /whoami, which anyone can ask; so a token that doesn't parse is
// simply not the host's.

interface Jwk extends JsonWebKey {
  kid: string;
}

let certs: { keys: Jwk[]; fetched: number } | null = null;

async function keys(team: string): Promise<Jwk[]> {
  if (certs && Date.now() - certs.fetched < 10 * 60_000) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  certs = { keys: body.keys, fetched: Date.now() };
  return certs.keys;
}

function b64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const decode = <T>(part: string): T => JSON.parse(new TextDecoder().decode(b64url(part))) as T;

export interface AccessConfig {
  team: string; // e.g. dry-hat-4b71.cloudflareaccess.com
  aud: string; // the Access application's audience tag
  allowed: string[]; // emails
}

/** The verified email, or null. */
export async function verifyAccess(request: Request, cfg: AccessConfig): Promise<string | null> {
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie;
  if (!token) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  try {
    const header = decode<{ kid?: string; alg?: string }>(h);
    if (header.alg !== 'RS256') return null;
    const jwk = (await keys(cfg.team)).find((k) => k.kid === header.kid);
    if (!jwk) {
      // Keys rotate: look again next time, but at most once a minute (anyone can send a token).
      if (certs && Date.now() - certs.fetched > 60_000) certs = null;
      return null;
    }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = decode<{ aud?: string | string[]; exp?: number; iss?: string; email?: string }>(p);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    if (claims.iss !== `https://${cfg.team}`) return null;
    const email = claims.email?.toLowerCase();
    if (!email || !cfg.allowed.map((e) => e.toLowerCase()).includes(email)) return null;
    return email;
  } catch {
    // Not base64, not JSON, not a key: not a token of ours.
    return null;
  }
}

/** The host's verified email, or null for anyone else. Local development has no Access in front: there, everyone is the host ('dev'). */
export async function hostOf(request: Request, env: Pick<Env, 'ACCESS_MODE' | 'ACCESS_TEAM' | 'ACCESS_AUD' | 'ALLOWED_EMAILS'>): Promise<string | null> {
  if (env.ACCESS_MODE === 'off') return 'dev';
  return verifyAccess(request, {
    team: env.ACCESS_TEAM,
    aud: env.ACCESS_AUD,
    allowed: env.ALLOWED_EMAILS.split(',').map((s) => s.trim()).filter(Boolean),
  });
}
