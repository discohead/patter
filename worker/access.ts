// Cloudflare Access, checked again inside the Worker: the hostname's Access
// application lets only the allowed identities through, and the Worker
// refuses any agent request that doesn't carry a valid Access JWT for that
// application — so nothing else that might reach the Worker can use it.

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
  const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid?: string; alg?: string };
  if (header.alg !== 'RS256') return null;
  const jwk = (await keys(cfg.team)).find((k) => k.kid === header.kid);
  if (!jwk) {
    certs = null; // keys rotate; try once more next time
    return null;
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { aud?: string | string[]; exp?: number; iss?: string; email?: string };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  if (claims.iss !== `https://${cfg.team}`) return null;
  const email = claims.email?.toLowerCase();
  if (!email || !cfg.allowed.map((e) => e.toLowerCase()).includes(email)) return null;
  return email;
}
