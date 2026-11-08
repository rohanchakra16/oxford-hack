/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { MAIN_URL } from '../main-eeg.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

/**
 * Automated GEOMETRY check only: with a stand-in camera that asks the UI to show dots at known viewport
 * coordinates, the rendered dot must sit exactly there (setup sheet, glass bar and layout transforms must not
 * displace it). It says nothing about real-camera gaze accuracy, which needs a person and a webcam.
 */
const fixture = `
  export function createGazeCamera(options) {
    return {
      start: async () => {},
      calibrate: async (ui) => {
        const w = window.innerWidth, h = window.innerHeight;
        const points = [{x:48,y:48},{x:w-48,y:h/2},{x:w/2,y:h-48},{x:w/2,y:h/2}];
        window.__expected = [];
        for (let i = 0; i < points.length; i++) {
          window.__expected.push(points[i]);
          ui.show(points[i], i, points.length);
          await new Promise((r) => setTimeout(r, 700));
        }
        ui.hide();
        options.onCalibration({id:'geometry',status:'valid'});
      },
      getCalibration: () => null,
      stop: () => {}
    };
  }`;

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['laptop', { width: 1280, height: 720 }], ['narrow', { width: 390, height: 844 }]] as const) {
  test(`calibration dots render at their viewport coordinates (${name})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: fixture }));
    await page.goto(`${MAIN_URL}/?adapter=synthetic`);
    await page.locator('input[type="file"][accept*="video"]').setInputFiles(await makeSyntheticLecture());
    await page.getByRole('button', { name: 'Session setup', exact: true }).click();
    await page.getByRole('button', { name: 'Calibrate gaze' }).click();
    const dot = page.locator('.calibration-dot');
    const seen: Array<{ dx: number; dy: number }> = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForFunction((n) => (window as unknown as { __expected?: unknown[] }).__expected?.length === n, i + 1);
      await page.waitForTimeout(80);
      const box = (await dot.boundingBox())!;
      const expected = await page.evaluate((n) => (window as unknown as { __expected: Array<{ x: number; y: number }> }).__expected[n], i);
      seen.push({ dx: box.x + box.width / 2 - expected.x, dy: box.y + box.height / 2 - expected.y });
    }
    for (const d of seen) { expect(Math.abs(d.dx)).toBeLessThanOrEqual(1); expect(Math.abs(d.dy)).toBeLessThanOrEqual(1); }
  });
}
