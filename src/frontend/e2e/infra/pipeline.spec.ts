import { expect, test } from '@playwright/test';
import { backendState, candidateEnvelope, inject, startPlayingSession, uid } from './helpers';

/** Evidence from `agoEnd`..`agoEnd+4000` ms before the backend's now, decided now. */
async function freshCandidate(sessionId: string, eventId: string) {
  const { nowBackendMs: now } = await backendState();
  return candidateEnvelope(sessionId, eventId, { start: now - 5000, end: now - 1000 }, now);
}

test('an injected candidate becomes one mapped bookmark; a duplicate is rejected, not duplicated', async ({ page }) => {
  const sessionId = await startPlayingSession(page, 'e2e-bookmark');
  await page.waitForTimeout(6000); // let telemetry confirm playback over the evidence window
  const eventId = uid('evt');
  expect((await inject(sessionId, await freshCandidate(sessionId, eventId))).accepted).toBe(true);
  const row = page.getByTestId('bookmark-row');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row).toHaveAttribute('data-bookmark-id', `bm-${eventId}`);

  expect((await inject(sessionId, await freshCandidate(sessionId, eventId))).accepted).toBe(true);
  await expect(page.locator('[data-testid="rejection"][data-reason="duplicate"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('bookmark-row')).toHaveCount(1);
  await expect(page.getByTestId('bookmark-count')).toHaveText('1 bookmark(s)');
});

test('mapped bookmark timing agrees with virtual media time within the stated uncertainty', async ({ page }) => {
  const sessionId = await startPlayingSession(page, 'e2e-timing');
  await page.waitForTimeout(7000);
  const { nowBackendMs: now } = await backendState();
  const eventId = uid('evt');
  await inject(sessionId, candidateEnvelope(sessionId, eventId, { start: now - 6000, end: now - 2000 }, now));
  const row = page.getByTestId('bookmark-row');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  const media = Number(await page.getByTestId('media-state').getAttribute('data-media-time'));
  const evEnd = Number(await row.getAttribute('data-evidence-end-media-s'));
  const unc = Number(await row.getAttribute('data-uncertainty-ms'));
  // evidence ended ~2 s of wall time before "now"; media plays at 1x with no pauses in this scenario
  expect(media - evEnd).toBeGreaterThan(1.0);
  expect(media - evEnd).toBeLessThan(3.5 + unc / 1000);
  expect(Number(await row.getAttribute('data-evidence-start-media-s'))).toBeLessThan(evEnd);
});

test('a candidate whose runKind disagrees with the session is rejected as invalid', async ({ page }) => {
  const sessionId = await startPlayingSession(page, 'e2e-runkind');
  const { nowBackendMs: now } = await backendState();
  await inject(sessionId, candidateEnvelope(sessionId, uid('evt'), { start: now - 5000, end: now - 1000 }, now, 'replay'));
  await expect(page.locator('[data-testid="rejection"][data-reason="invalid"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('0 bookmark(s)');
});

test('a stale candidate (decision older than the limit) is rejected as too_old', async ({ page }) => {
  const sessionId = await startPlayingSession(page, 'e2e-old');
  // the backend clock is monotonic since boot, so on a fresh machine wait until "31 s ago" is non-negative
  await expect.poll(async () => (await backendState()).nowBackendMs, { timeout: 60_000 }).toBeGreaterThan(36_000);
  const { nowBackendMs: now } = await backendState();
  await inject(sessionId, candidateEnvelope(sessionId, uid('evt'), { start: now - 35_000, end: now - 32_000 }, now - 31_000));
  await expect(page.locator('[data-testid="rejection"][data-reason="too_old"]')).toHaveCount(1, { timeout: 10_000 });
});

test('evidence that spans a pause is rejected, never mapped across the boundary', async ({ page }) => {
  const sessionId = await startPlayingSession(page, 'e2e-boundary');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(2500);
  const { nowBackendMs: now } = await backendState();
  await inject(sessionId, candidateEnvelope(sessionId, uid('evt'), { start: now - 5000, end: now - 500 }, now));
  await expect(page.getByTestId('rejection').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('0 bookmark(s)');
});

test('a candidate for an unknown session creates no backend state', async () => {
  const { nowBackendMs: now } = await backendState();
  await inject('ses-does-not-exist', candidateEnvelope('ses-does-not-exist', uid('evt'), { start: now - 5000, end: now - 1000 }, now));
  expect((await backendState()).sessions.some((s) => s.sessionId === 'ses-does-not-exist')).toBe(false);
});
