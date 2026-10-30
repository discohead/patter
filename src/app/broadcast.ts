// Going on air, from the host's page. One tab broadcasts at a time: this
// tab's id (kept for the tab's life, so a reload carries on, but never
// shared with a duplicate of the tab) goes with every update, and the OnAir
// object refuses updates from any other, so a second tab (or the phone in
// your pocket) can't talk over the one on air until you take over from it. The patch goes out with each autosave, the
// conversation whenever it settles, the transport as it changes. Updates go
// one at a time, oldest first; the ones waiting merge, so a burst of changes
// costs one request.

import type { OnAirStatus, OnAirUpdate, TranscriptMessage } from './on-air';

const PUBLISHER_KEY = 'patter.on-air.publisher';
const CHANNEL = 'patter.on-air';

/**
 * This tab's id. sessionStorage keeps it through a reload, but "duplicate
 * tab" copies sessionStorage too, so the page first asks the other open tabs
 * whether one of them goes by it, and takes a new one if so.
 */
export async function claimPublisherId(): Promise<string> {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(PUBLISHER_KEY);
  } catch {
    /* no storage: a new id */
  }
  if (id && typeof BroadcastChannel !== 'undefined') {
    const asked = id;
    const taken = await new Promise<boolean>((resolve) => {
      const channel = new BroadcastChannel(CHANNEL);
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const answer = (yes: boolean) => {
        clearTimeout(timer);
        channel.close();
        resolve(yes);
      };
      timer = setTimeout(() => answer(false), 300);
      channel.onmessage = (e) => (e.data as { mine?: string } | null)?.mine === asked && answer(true);
      channel.postMessage({ who: asked });
    });
    if (taken) id = null;
  }
  id ??= crypto.randomUUID();
  try {
    sessionStorage.setItem(PUBLISHER_KEY, id);
  } catch {
    /* kept for this page only */
  }
  return id;
}

type Change = Omit<OnAirUpdate, 'publisher' | 'live'> & { session: string };
type Reply = { ok: true; status: OnAirStatus; listeners: number } | { ok: false; reason: 'elsewhere' | 'off' };

export class Broadcast {
  /** off; on (this tab is broadcasting); elsewhere (another of the host's tabs or devices is). */
  state: 'off' | 'on' | 'elsewhere' = 'off';
  /** Since when it's been on (or off) air. */
  since = 0;
  /** How many were listening, as of the last update. */
  listeners = 0;
  busy = false;
  /** The last thing that went wrong (cleared by the next thing that goes right). */
  error: string | null = null;
  private claimed: Promise<string> | null = null;
  private queue: Change[] = [];
  private flying = false;
  /** The conversation last sent, per session, so an unchanged one isn't sent again. */
  private said = '';

  constructor(private readonly changed: () => void) {}

  /** This tab's id, settled once; from then on it tells a duplicate of this tab that the id is taken. */
  private publisher(): Promise<string> {
    this.claimed ??= claimPublisherId().then((id) => {
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (e) => (e.data as { who?: string } | null)?.who === id && channel.postMessage({ mine: id });
      }
      return id;
    });
    return this.claimed;
  }

  /** After a reload: carry on if this tab was the one on air. */
  async resume(): Promise<void> {
    try {
      const res = await fetch(`/api/on-air?publisher=${encodeURIComponent(await this.publisher())}`, { credentials: 'same-origin', headers: { 'x-patter': '1' } });
      if (!res.ok) return;
      const r = (await res.json()) as { status: OnAirStatus; mine: boolean; listeners: number };
      this.state = r.status.live ? (r.mine ? 'on' : 'elsewhere') : 'off';
      this.since = r.status.since;
      this.listeners = r.listeners;
      this.changed();
    } catch {
      /* the broadcast can wait: going on air asks again */
    }
  }

  /** Go on air with everything (or take it over from another tab). */
  async goLive(everything: Change): Promise<void> {
    await this.toggle({ ...everything, live: true });
    if (this.state === 'on' && everything.transcript) this.said = `${everything.session}:${JSON.stringify(everything.transcript)}`;
  }

  /** Off air: listeners keep the last patch, and see since when. */
  goOff(): Promise<void> {
    return this.toggle({ live: false });
  }

  /** What changed, while this tab is on air. */
  send(change: Change): void {
    if (this.state !== 'on') return;
    const last = this.queue[this.queue.length - 1];
    // Waiting updates for the same session merge (the newest of each field wins).
    if (last && last.session === change.session) Object.assign(last, change);
    else this.queue.push({ ...change });
    if (!this.flying) void this.flush();
  }

  /** The conversation, if it's different from what listeners have. */
  sendTranscript(session: string, transcript: TranscriptMessage[]): void {
    if (this.state !== 'on') return;
    const said = `${session}:${JSON.stringify(transcript)}`;
    if (said === this.said) return;
    this.said = said;
    this.send({ session, transcript });
  }

  private async toggle(update: Omit<OnAirUpdate, 'publisher'>): Promise<void> {
    this.busy = true;
    this.changed();
    try {
      const r = await this.put(update);
      if (r.ok) {
        this.state = update.live ? 'on' : 'off';
        this.queue = [];
      }
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async flush(): Promise<void> {
    this.flying = true;
    try {
      while (this.queue.length && this.state === 'on') {
        const change = this.queue.shift()!;
        try {
          await this.put(change);
        } catch (e) {
          // Offline for a moment: the next change carries the patch again.
          this.error = (e as Error).message;
          this.changed();
        }
      }
    } finally {
      this.flying = false;
    }
  }

  private async put(update: Omit<OnAirUpdate, 'publisher'>): Promise<Reply> {
    const publisher = await this.publisher();
    const res = await fetch('/api/on-air', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...update, publisher }),
    });
    if (!res.ok && res.status !== 409) {
      let msg = `couldn't reach the broadcast (${res.status})`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        if (res.status === 403 || res.redirected) msg = 'not signed in: sign in again at /login';
      }
      throw new Error(msg);
    }
    const r = (await res.json()) as Reply;
    this.error = null;
    if (r.ok) {
      this.since = r.status.since;
      this.listeners = r.listeners;
    } else {
      // Another tab took over, or the broadcast was ended from elsewhere: stop sending.
      this.state = r.reason === 'elsewhere' ? 'elsewhere' : 'off';
      this.queue = [];
    }
    this.changed();
    return r;
  }
}
