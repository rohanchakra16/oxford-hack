/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { MAIN_URL } from '../main-eeg.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

/**
 * UI wiring check with a STAND-IN camera that reports scripted gaze frames (state and position set from the test)
 * through the same onSample path the real engine uses. It proves the app turns reported frames into the border,
 * crosshair and gaze timeline, and that uncertain/lost frames never look like "on" or "away". It says nothing
 * about real webcam accuracy; that needs a person and a camera.
 */
const fixture = `
  export function createGazeCamera(options) {
    let timer;
    return {
      start: async () => {},
      calibrate: async (ui) => {
        ui.show({ x: 200, y: 200 }, 0, 1);
        await new Promise((r) => setTimeout(r, 100));
        ui.hide();
        options.onCalibration({ id: 'fake', status: 'valid' });
        window.__gaze = { state: 'on', x: 640, y: 360, reason: null };
        timer = setInterval(() => {
          const g = window.__gaze;
          options.onSample({ tMs: performance.now(), state: g.state, viewport: g.state === 'lost' ? null : { x: g.x, y: g.y }, pInside: null, reason: g.state === 'lost' ? g.reason : null });
        }, 33);
      },
      getCalibration: () => null,
      stop: () => clearInterval(timer),
    };
  }`;

test('gaze border, crosshair and timeline reflect reported frames, independent of EEG', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: fixture }));
  await page.goto(`${MAIN_URL}/?adapter=synthetic`);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(await makeSyntheticLecture());
  const set = (g: object) => page.evaluate((v) => { Object.assign((window as unknown as { __gaze: object }).__gaze, v); }, g);

  // Nothing is drawn before the camera is calibrated and tracking.
  await expect(page.getByTestId('gaze-border')).toHaveCount(0);
  await page.getByRole('tab', { name: /Attention/ }).click();
  await expect(page.getByTestId('gaze-now')).toContainText('Camera not tracking');
  await expect(page.getByTestId('gaze-strip')).toHaveCount(0);

  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate gaze' }).click();
  await page.getByRole('button', { name: 'Continue to lecture' }).click();
  await page.getByRole('button', { name: /^Play/ }).first().click();

  // Looking at the video: no border; the crosshair (when enabled) sits at the reported position.
  await expect(page.getByTestId('gaze-now')).toContainText('Looking at the video');
  await expect(page.getByTestId('gaze-border')).toHaveCount(0);
  await expect(page.getByTestId('gaze-crosshair')).toHaveCount(0); // off by default
  await page.getByLabel('Show gaze crosshair').check();
  const cross = page.getByTestId('gaze-crosshair');
  await expect(cross).toBeVisible();
  await expect.poll(async () => { const b = (await cross.boundingBox())!; return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; }).toEqual([640, 360]);
  await set({ x: 900, y: 500 });
  await expect.poll(async () => { const b = (await cross.boundingBox())!; return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; }).toEqual([900, 500]);

  // Confidently away: red border around the player only, and the crosshair turns red.
  await set({ state: 'off', x: 1400, y: 880 });
  const border = page.getByTestId('gaze-border');
  await expect(border).toHaveAttribute('data-state', 'off');
  await expect(cross).toHaveAttribute('data-state', 'off');
  await expect(page.getByTestId('gaze-now')).toContainText('Looking away');
  const box = (await border.boundingBox())!;
  const stage = (await page.locator('.lp-stage').boundingBox())!;
  expect(Math.abs(box.width - stage.width)).toBeLessThanOrEqual(6); // (the stage has its own border) it surrounds the video, not the whole app
  expect(box.width).toBeLessThan(1440 * 0.9);
  await expect(border).toHaveCSS('box-shadow', /229, 55, 46/);
  await page.screenshot({ path: 'docs/design/gaze/looking-away.png' });

  // Uncertain: neutral (not red) border, dashed crosshair.
  await set({ state: 'uncertain', x: 700, y: 400 });
  await expect(border).toHaveAttribute('data-state', 'unsure');
  await expect(cross).toHaveAttribute('data-state', 'uncertain');
  await page.screenshot({ path: 'docs/design/gaze/uncertain.png' });

  // Face lost: neutral border, crosshair disappears, and the reason is stated; never shown as away.
  await set({ state: 'lost', reason: 'FACE_NOT_DETECTED' });
  await expect(border).toHaveAttribute('data-state', 'unsure');
  await expect(cross).toHaveCount(0);
  await expect(page.getByTestId('gaze-now')).toContainText('Not measurable');
  await expect(page.getByTestId('gaze-now')).toContainText('face not detected');

  // Back on the video: border gone. The timeline has its own strip with all four states recorded, and the
  // EEG graph is a separate element.
  await set({ state: 'on', x: 640, y: 360 });
  await expect(border).toHaveCount(0);
  await expect(page.getByTestId('gaze-strip')).toBeVisible();
  await page.getByTestId('gaze-section').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/design/gaze/timeline.png' });
  await expect(page.getByTestId('gaze-strip')).toHaveAttribute('aria-label', /Looking at the video \d+%, away \d+%/);
  await page.getByLabel('Red border when looking away').uncheck();
  await set({ state: 'off' });
  await expect(page.getByTestId('gaze-now')).toContainText('Looking away');
  await expect(border).toHaveCount(0);
});
