/**
 * Live adapter unit tests. SCOPE: the WebSocket and fetch are FAKES here, so these tests prove the
 * client's state machine, not the real connection. Real backend communication is covered by the
 * Playwright integration tests in e2e/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ManualTimers } from '../timers';
import { LiveReviewClient, type WebSocketLike } from './client';

const fixture = (t: string) =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/valid/${t}.json`, import.meta.url), 'utf8'));

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

let seq = 0;
function server(type: string, payload: unknown, sessionId: string | null = null) {
  return { schemaVersion: '0.1.0', messageId: `s-${++seq}`, sessionId, seq: seq, type, payload };
}

function hello(instance: string, outcome = 'new', sessionId: string | null = null) {
  return server('server_hello', {
    backendInstanceId: instance,
    connectionId: 'c',
    resumeOutcome: outcome,
    sessionId,
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 6000,
    tBackendMs: 1,
  });
}

function setup(opts: { token?: string | null } = {}) {
  const timers = new ManualTimers(1000);
  const sockets: FakeSocket[] = [];
  let instance = 'be-1';
  const handshakes: unknown[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    handshakes.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ sessionToken: `tok_${handshakes.length}_0123456789abcdef`, backendInstanceId: instance, schemaVersion: '0.1.0', expiresInMs: 1, wsPath: '/ws/v0' }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const client = new LiveReviewClient({
    backendUrl: 'http://127.0.0.1:8765',
    getLaunchToken: () => (opts.token === undefined ? 'launch-token-0123456789' : opts.token),
    timers,
    fetch: fetchFn,
    createWebSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    clientInstanceId: 'client-test',
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    timers, client, sockets, handshakes, flush,
    setInstance: (i: string) => (instance = i),
    last: () => sockets[sockets.length - 1]!,
  };
}

async function connectWithSession(t: ReturnType<typeof setup>) {
  t.client.connect();
  await t.flush();
  t.last().open();
  t.last().deliver(hello('be-1'));
  t.client.startSession({ videoId: 'video-fixture', runKind: 'simulated', sensors: { eeg: true, gaze: true }, mediaDurationS: 600 });
  const config = fixture('session_config');
  t.last().deliver(server('session_config', config.payload, config.payload.sessionId));
  return config.payload.sessionId as string;
}

describe('LiveReviewClient', () => {
  it('requires pairing when there is no launch token', async () => {
    const t = setup({ token: null });
    t.client.connect();
    await t.flush();
    expect(t.client.getSnapshot().connection.state).toBe('pairing_required');
    expect(t.sockets).toHaveLength(0);
  });

  it('handshakes, sends client_hello first, and starts a session', async () => {
    const t = setup();
    const sid = await connectWithSession(t);
    expect(t.handshakes[0]).toEqual({ launchToken: 'launch-token-0123456789', clientInstanceId: 'client-test' });
    expect(t.last().url).toBe('ws://127.0.0.1:8765/ws/v0');
    expect(t.last().types().slice(0, 2)).toEqual(['client_hello', 'session_start']);
    expect(t.client.getSnapshot().connection.state).toBe('connected');
    expect(t.client.getSnapshot().session?.sessionId).toBe(sid);
  });

  it('answers clock pings immediately', async () => {
    const t = setup();
    await connectWithSession(t);
    t.last().deliver(server('clock_ping', { pingId: 'p1', tBackendSendMs: 5 }));
    const pong = t.last().sent.find((m) => m.type === 'clock_pong')!;
    expect(pong.payload).toMatchObject({ pingId: 'p1', tBackendSendMs: 5, tBrowserRecvMs: 1000 });
  });

  it('does not duplicate a retransmitted bookmark', async () => {
    const t = setup();
    const sid = await connectWithSession(t);
    const bm = fixture('review_bookmark').payload;
    t.last().deliver(server('review_bookmark', bm, sid));
    t.last().deliver(server('review_bookmark', bm, sid));
    expect(t.client.getSnapshot().bookmarks).toHaveLength(1);
  });

  it('rejects an invalid message without dropping the connection', async () => {
    const t = setup();
    const sid = await connectWithSession(t);
    t.last().deliver(server('review_bookmark', { ...fixture('review_bookmark').payload, suggestedMediaS: -5 }, sid));
    t.last().deliver('{"not json');
    const s = t.client.getSnapshot();
    expect(s.connection.state).toBe('connected');
    expect(s.bookmarks).toHaveLength(0);
    expect(s.errors.map((e) => e.code)).toEqual(['invalid_message', 'invalid_json']);
  });

  it('ignores messages for an obsolete session', async () => {
    const t = setup();
    await connectWithSession(t);
    t.last().deliver(server('review_bookmark', fixture('review_bookmark').payload, 'ses-old'));
    expect(t.client.getSnapshot().bookmarks).toHaveLength(0);
  });

  it('reconnects, re-handshakes and asks to resume the same session', async () => {
    const t = setup();
    const sid = await connectWithSession(t);
    t.last().close(1006, 'network');
    expect(t.client.getSnapshot().connection.state).toBe('reconnecting');
    t.timers.advance(250);
    await t.flush();
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    const h = t.last().sent[0]!;
    expect(h.type).toBe('client_hello');
    expect((h.payload as { resume: unknown }).resume).toMatchObject({ sessionId: sid, backendInstanceId: 'be-1' });
    const snap = fixture('session_snapshot').payload;
    t.last().deliver(hello('be-1', 'resumed', sid));
    t.last().deliver(server('session_snapshot', snap, sid));
    expect(t.client.getSnapshot().session?.sessionId).toBe(sid);
    expect(t.client.getSnapshot().bookmarks).toHaveLength(1);
  });

  it('detects a backend restart, drops the old session and starts a new one', async () => {
    const t = setup();
    await connectWithSession(t);
    t.client.markBookmark(10); // sent immediately
    t.setInstance('be-2');
    t.last().close(1006, 'backend exited');
    t.timers.advance(250);
    await t.flush();
    const s = t.client.getSnapshot();
    expect(s.connection.backendRestarted).toBe(true);
    expect(s.session).toBeNull();
    expect(s.errors.map((e) => e.code)).toContain('backend_restarted');
    t.last().open();
    t.last().deliver(hello('be-2', 'backend_restarted'));
    expect(t.last().types()).toEqual(['client_hello', 'session_start']);
  });

  it('closes and reconnects after a heartbeat timeout', async () => {
    const t = setup();
    await connectWithSession(t);
    t.timers.advance(8000);
    expect(t.client.getSnapshot().connection.state).toBe('reconnecting');
  });

  it('stops reconnecting after disconnect()', async () => {
    const t = setup();
    await connectWithSession(t);
    t.client.disconnect();
    t.timers.advance(60_000);
    await t.flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.client.getSnapshot().connection.state).toBe('closed');
  });
});
