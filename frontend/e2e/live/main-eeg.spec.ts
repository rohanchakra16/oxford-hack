/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MAIN_BACKEND, MAIN_URL } from '../main-eeg.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

test('main normal-viewing flow maps controlled live-model windows, stacks reminders, and suppresses replay', async ({ page }) => {
  test.setTimeout(60_000);
  const lecture = await makeSyntheticLecture();
  const token = readFileSync('frontend/test-results/main-eeg-token', 'utf8').trim();
  const eligibility: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.type === 'playback_eligibility') eligibility.push(message.payload.reason);
    } catch { /* Ignore transport frames outside the JSON protocol. */ }
  }));
  await page.goto(`${MAIN_URL}/?signals=eeg#pair=${token}`);
  await expect(page.getByText('Session connected')).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByText(/Experimental EEG reminders/)).toBeVisible();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  const reminders = page.getByTestId('review-reminder');
  await expect(reminders).toHaveCount(1, { timeout: 20_000 }).catch(async (error: Error) => {
    const diagnostics = await (await fetch(`${MAIN_BACKEND}/api/v0/test/state`, { headers: { 'x-launch-token': token } })).json();
    throw new Error(`${error.message}\nBackend diagnostics: ${JSON.stringify(diagnostics)}`);
  });
  await expect(page.locator('article.bookmark-card')).toHaveCount(1);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  const headers = { 'x-launch-token': token, 'content-type': 'application/json' };
  const state = await (await fetch(`${MAIN_BACKEND}/api/v0/test/state`, { headers })).json();
  const session = state.sessions.find((s: { connected: boolean; runKind: string }) => s.connected && s.runKind === 'live');
  const now = state.nowBackendMs;
  // Exercise two independently delivered reminders without waiting a second cooldown.
  // Dwell/cooldown enforcement is tested against the actual adapter in Python.
  const injected = await fetch(`${MAIN_BACKEND}/api/v0/test/inject`, {
    method: 'POST', headers,
    body: JSON.stringify({ sessionId: session.sessionId, message: {
      schemaVersion: '0.2.0', messageId: 'second-controlled-reminder', sessionId: session.sessionId, seq: 0,
      type: 'review_candidate', payload: {
        eventId: 'second-controlled-event', detector: { detectorId: 'controlled-test', detectorVersion: '0', configVersion: 'test' },
        mode: 'eeg_only', evidence: { startBackendMs: now - 3000, endBackendMs: now - 1000 },
        decisionBackendMs: now, eligibilityEpoch: null,
        contributingSignals: [{ signal: 'eeg', windowIds: ['controlled-test'], scores: [{ name: 'attention_score', value: 5, scale: 'score_0_100', missingReason: null }] }],
        provenance: { runKind: 'live', producer: 'controlled-test-only', producerVersion: '0' },
      },
    } }),
  });
  expect((await injected.json()).accepted).toBe(true);
  await expect(reminders).toHaveCount(2);
  await expect(page.locator('article.bookmark-card')).toHaveCount(2);
  await reminders.first().getByRole('button', { name: /Close reminder/ }).click();
  await expect(reminders).toHaveCount(1);
  await expect(page.locator('article.bookmark-card')).toHaveCount(2);
  await reminders.first().getByRole('button', { name: 'Replay', exact: true }).click();
  // No transcript: the main UI seeks and continues; bounded replay is covered below.
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('input[type="file"][accept*=".vtt"]').setInputFiles({
    name: 'test.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00.000 --> 00:30.000\nControlled transcript.\n'),
  });
  await reminders.first().getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => eligibility.includes('review_replay')).toBe(true);
  await expect(reminders).toHaveCount(1);
  await expect(page.locator('article.bookmark-card')).toHaveCount(2);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.screenshot({ path: 'test-results/main-eeg/main-reminder-stack.png', fullPage: true });
});
