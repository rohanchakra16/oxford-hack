import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { BACKEND_URL, FRONTEND_URL, TOKEN_FILE } from '../../playwright.config';

export const launchToken = (): string => readFileSync(TOKEN_FILE, 'utf8').trim();

/** Open the diagnostics page paired with the test backend (token travels in the URL fragment only). */
export async function openDiagnostics(page: Page, query = ''): Promise<void> {
  await page.goto(`${FRONTEND_URL}/diagnostics${query}#pair=${launchToken()}`);
}

export async function waitConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('connection-state')).toHaveText('connected', { timeout: 15_000 });
}

export async function startSession(page: Page, opts: { runKind?: 'simulated' | 'live'; videoId?: string; eeg?: boolean } = {}) {
  if (opts.videoId) await page.getByLabel('Video id').fill(opts.videoId);
  if (opts.runKind) await page.getByLabel('Run kind').selectOption(opts.runKind);
  const eeg = page.getByLabel('EEG');
  if (opts.eeg === false) await eeg.uncheck();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByTestId('session-id')).not.toHaveText('—', { timeout: 15_000 });
}

export interface TestState {
  nowBackendMs: number;
  backendInstanceId: string;
  sessions: { sessionId: string; videoId: string; runKind: string; connected: boolean; bookmarks: number; segments: string[]; counters: Record<string, number> }[];
  endedSessions: string[];
}

const hookHeaders = () => ({ 'x-launch-token': launchToken() });

export async function backendState(): Promise<TestState> {
  const r = await fetch(`${BACKEND_URL}/api/v0/test/state`, { headers: hookHeaders() });
  if (!r.ok) throw new Error(`test/state ${r.status}`);
  return (await r.json()) as TestState;
}

export async function inject(sessionId: string, message: unknown): Promise<{ accepted: boolean; code?: string }> {
  const r = await fetch(`${BACKEND_URL}/api/v0/test/inject`, {
    method: 'POST',
    headers: { ...hookHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  return (await r.json()) as { accepted: boolean; code?: string };
}

let counter = 0;
export const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${counter++}`;

/** A review_candidate envelope as P3's detector would emit it (EEG only, simulated provenance). */
export function candidateEnvelope(sessionId: string, eventId: string, evidence: { start: number; end: number }, decisionMs: number, runKind = 'simulated') {
  return {
    schemaVersion: '0.1.0',
    messageId: uid('msg'),
    sessionId,
    seq: 0,
    type: 'review_candidate',
    payload: {
      eventId,
      detector: { detectorId: 'e2e-injected', detectorVersion: '0.0.0', configVersion: 'e2e' },
      mode: 'eeg_only',
      evidence: { startBackendMs: evidence.start, endBackendMs: evidence.end },
      decisionBackendMs: decisionMs,
      eligibilityEpoch: null,
      contributingSignals: [
        { signal: 'eeg', windowIds: ['e2e-w1'], scores: [{ name: 'placeholder', value: null, scale: 'none', missingReason: 'e2e injected' }] },
      ],
      provenance: { runKind, producer: 'e2e', producerVersion: '0.0.0' },
    },
  };
}

/** Start a simulated session and play virtual media until the backend has confirmed playback. */
export async function startPlayingSession(page: Page, videoId: string): Promise<string> {
  await openDiagnostics(page);
  await waitConnected(page);
  await startSession(page, { videoId });
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('eligibility')).toContainText('eligible', { timeout: 10_000 });
  return (await page.getByTestId('session-id').textContent())!;
}
