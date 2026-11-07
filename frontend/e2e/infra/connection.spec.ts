import { expect, test } from '@playwright/test';
import { openDiagnostics, startSession, waitConnected } from './helpers';

test('diagnostics page loads and is labelled as an engineering harness', async ({ page }) => {
  await openDiagnostics(page);
  await expect(page.getByRole('heading', { name: 'Developer diagnostics' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('not the product UI');
  await expect(page.getByTestId('adapter-kind')).toHaveText('live');
});

test('connects to the real backend and clock sync converges', async ({ page }) => {
  await openDiagnostics(page);
  await waitConnected(page);
  await expect(page.getByTestId('backend-instance')).not.toHaveText('—');
  await expect(page.getByTestId('clock-state')).toContainText('samples', { timeout: 15_000 });
  await expect(page.getByTestId('clock-state')).not.toContainText('0 samples', { timeout: 15_000 });
  // the pairing token is removed from the address bar once captured
  expect(page.url()).not.toContain('pair=');
});

test('a tab without the launch token cannot connect', async ({ page }) => {
  await page.goto('/diagnostics');
  await expect(page.getByTestId('connection-state')).not.toHaveText('connected', { timeout: 5_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('connection-state')).not.toHaveText('connected');
});

test('a simulated session starts and reports sensors', async ({ page }) => {
  await openDiagnostics(page);
  await waitConnected(page);
  await startSession(page, { videoId: 'e2e-start' });
  await expect(page.getByTestId('session-video')).toHaveText('e2e-start');
  await expect(page.getByTestId('session-run-kind')).toHaveText('simulated');
  await expect(page.getByTestId('sensor-eeg')).toBeVisible({ timeout: 10_000 });
});
