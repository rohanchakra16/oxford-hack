import { expect, test } from '@playwright/test';
import { openDiagnostics, startSession, waitConnected } from './helpers';

test('malformed and contract-invalid messages are rejected without crashing the page or session', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await openDiagnostics(page);
  await waitConnected(page);
  await startSession(page, { videoId: 'e2e-invalid' });
  const sessionId = await page.getByTestId('session-id').textContent();

  const raw = page.getByLabel('Raw message to send (diagnostics only)');
  await raw.fill('{"not": "a valid message"');
  await page.getByRole('button', { name: 'Send raw message' }).click();
  await expect(page.getByTestId('error').first()).toBeVisible({ timeout: 10_000 });

  await raw.fill(JSON.stringify({ schemaVersion: '0.2.0', messageId: 'm-bad', sessionId, seq: 99, type: 'no_such_type', payload: {} }));
  await page.getByRole('button', { name: 'Send raw message' }).click();
  await expect(page.getByTestId('error').nth(1)).toBeVisible({ timeout: 10_000 });

  // the session and connection survive
  await expect(page.getByTestId('session-id')).toHaveText(sessionId!);
  expect(pageErrors).toEqual([]);
});

test('after a dropped connection the client reconnects and resumes the same session', async ({ page }) => {
  await openDiagnostics(page);
  await waitConnected(page);
  await startSession(page, { videoId: 'e2e-reconnect' });
  const sessionId = await page.getByTestId('session-id').textContent();
  const instance = await page.getByTestId('backend-instance').textContent();

  await page.getByRole('button', { name: 'Drop connection' }).click();
  await waitConnected(page);
  await expect(page.getByTestId('session-id')).toHaveText(sessionId!);
  await expect(page.getByTestId('backend-instance')).toHaveText(instance!);
  await expect(page.getByTestId('session-video')).toHaveText('e2e-reconnect');
});

test('unavailable EEG in a live session is reported as unavailable, not as a lapse or a zero', async ({ page }) => {
  await openDiagnostics(page);
  await waitConnected(page);
  await startSession(page, { runKind: 'live', videoId: 'e2e-live-nosensor' });
  const eeg = page.getByTestId('sensor-eeg');
  await expect(eeg).toBeVisible({ timeout: 10_000 });
  const text = (await eeg.textContent()) ?? '';
  expect(text).toContain('unavailable');
  expect(text).not.toMatch(/lapse|attention|focus|\b0(\.0+)?\s*%/i);
  await expect(page.getByTestId('sensor-mode')).toContainText('automatic suggestions off');
  await expect(page.getByTestId('bookmark-count')).toHaveText('0 bookmark(s)');
});
