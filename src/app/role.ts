// Whose page this is. The host is whoever the Worker says carries the
// Access sign-in (GET /whoami); anyone else is a listener. So is the host
// with ?listen in the address: a way to see what listeners see, and, in
// local development (where there's no Access and everyone is the host), the
// way to be a listener at all. When in doubt, a listener: it reaches nothing.

export type Role = 'host' | 'listener';

export async function roleOf(
  location: { search: string },
  ask: (path: string) => Promise<Response> = (path) => fetch(path, { credentials: 'same-origin', cache: 'no-store' }),
): Promise<Role> {
  if (new URLSearchParams(location.search).has('listen')) return 'listener';
  try {
    const res = await ask('/whoami');
    if (!res.ok) return 'listener';
    return ((await res.json()) as { host?: unknown }).host === true ? 'host' : 'listener';
  } catch {
    return 'listener';
  }
}
