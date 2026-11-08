import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MAIN_URL } from '../main-eeg.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

const token = () => readFileSync('frontend/test-results/main-eeg-token', 'utf8').trim();

test('setup stays outside the viewing screen and closing it keeps the same player', async ({ page }) => {
  await page.goto(`${MAIN_URL}/#pair=${token()}`);
  await expect(page.getByText('Session connected')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Personal calibration', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your devices' })).not.toBeVisible();
  await page.locator('video').evaluate((video) => { video.dataset.setupIdentity = 'same-player'; });
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  const setup = page.locator('dialog.session-setup');
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Connection' })).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Personal calibration', exact: true })).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Calibrate attention', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/setup/desktop-setup.png' });
  await setup.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: 'test-results/setup/desktop-calibration.png' });
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await expect(setup).not.toBeVisible();
  await expect(page.locator('video')).toHaveAttribute('data-setup-identity', 'same-player');
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(setup).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Session setup', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  expect(await setup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await setup.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: 'test-results/setup/mobile-setup.png' });
});

test('new lectures and reloads automatically load the remembered profile without recalibrating', async ({ page }) => {
  const lecture = await makeSyntheticLecture();
  let participant = 'local';
  const loads: string[] = [];
  await page.route('**/api/v0/attention/**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      participant = body.participant;
      expect(body.action).toBe('load'); // no hidden calibration/start request on restore
      loads.push(participant);
      await route.fulfill({ json: { ok: true } });
    } else await route.fulfill({ json: {
      state: 'ready', reason: 'Saved baseline loaded', raw: 80, score: 80, level: 'within baseline',
      participant, calibrating: false, progress: 0, calibrationMessage: 'Saved personal calibration loaded', threshold: 70,
      profile: { mean: 80, std: 5, p10: 75, p90: 85, low: 70, recovery: 75, created: Date.now() / 1000 }, media: null,
    } });
  });
  await page.goto(`${MAIN_URL}/?setup=1#pair=${token()}`);
  await expect(page.locator('dialog.session-setup')).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  const name = page.getByRole('textbox', { name: 'Profile name' });
  await name.fill('Alice');
  await name.press('Tab');
  await expect.poll(() => loads.includes('Alice')).toBe(true);
  await expect(page.getByText('A compatible saved baseline is loaded. No repeat EEG calibration needed.')).toBeVisible();
  await page.reload();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByRole('textbox', { name: 'Profile name' })).toHaveValue('Alice');
  await expect.poll(() => loads.filter((name) => name === 'Alice').length).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
});

test('camera loading can be cancelled before dots appear, without hiding an active calibration', async ({ page }) => {
  const lecture = await makeSyntheticLecture();
  await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    export function createGazeCamera() { return {
      start: () => new Promise((resolve) => { window.releaseCameraStart = resolve; }),
      calibrate: async () => { throw new Error('Cancelled camera must never calibrate'); },
      getCalibration: () => null,
      stop: () => { document.documentElement.dataset.cameraStopped = 'true'; }
    }; }
  ` }));
  await page.goto(`${MAIN_URL}/?setup=1#pair=${token()}`);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await page.getByRole('button', { name: 'Calibrate gaze', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue to lecture', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Back to lecture' })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseCameraStart?: () => void }).releaseCameraStart)).toBe('function');
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseCameraStart: () => void }).releaseCameraStart());
  await expect(page.locator('html')).toHaveAttribute('data-camera-stopped', 'true');
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await expect(page.locator('dialog.session-setup')).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Gaze calibration' })).not.toBeVisible();
});
