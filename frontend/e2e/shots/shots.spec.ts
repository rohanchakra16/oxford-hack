/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { SHOTS_URL } from '../shots.config';
import { makeSlideLecture } from './slide';

/**
 * Not a regression test: captures screenshots of the real main app on the scripted TEST EEG source
 * (see docs/design/README.md). `SHOT_TAG=after node frontend/node_modules/@playwright/test/cli.js test --config frontend/e2e/shots.config.ts`
 * from the repository root. Output: docs/design/<tag>/<viewport>-<n>-<state>.png
 */
const tag = process.env.SHOT_TAG ?? 'adhoc';
const out = `docs/design/${tag}`;
const VTT = ['WEBVTT', '', ...[
  'Today we look at how a continuous signal becomes a list of numbers.',
  'Sampling means measuring the signal at regular instants in time.',
  'If we sample too slowly, fast changes are mistaken for slow ones.',
  'That mistake is called aliasing, and it cannot be undone afterwards.',
  'The sampling theorem tells us how fast is fast enough.',
  'We must sample at more than twice the highest frequency present.',
  'So engineers filter the signal before they sample it.',
  'Next we turn to the Fourier transform.',
  'It writes any signal as a sum of simple sinusoids.',
  'The magnitude tells us how much of each frequency there is.',
  'The phase tells us where each sinusoid begins.',
  'We will use both to design our first filter.',
].map((line, k) => {
  const mm = (s: number) => `00:${String(s).padStart(2, '0')}.000`;
  return `${mm(k * 3)} --> ${mm((k + 1) * 3)}\n${line}\n`;
})].join('\n');

const VIEWPORTS = [['desktop', { width: 1440, height: 900 }], ['laptop', { width: 1280, height: 720 }], ['narrow', { width: 390, height: 844 }]] as const;
const shot = (page: Page, name: string, full = false) => page.screenshot({ path: `${out}/${name}.png`, fullPage: full });

async function openApp(page: Page) {
  const token = readFileSync('frontend/test-results/shots-token', 'utf8').trim();
  await page.goto(`${SHOTS_URL}/#pair=${token}`);
  await expect(page.getByText('Session connected')).toBeVisible();
}
async function load(page: Page, withTranscript: boolean) {
  const lecture = await makeSlideLecture();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  if (withTranscript) {
    await page.locator('input[type="file"][accept*=".vtt"]').setInputFiles({ name: 'lecture-04.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
    await expect(page.getByText('Sampling means measuring', { exact: false })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /^play$/i })).toBeEnabled();
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.loop = true; return v.play(); });
}

for (const [name, viewport] of VIEWPORTS) {
  test(`screenshots ${name}`, async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(out, { recursive: true });
    await page.setViewportSize(viewport);
    await openApp(page);
    await shot(page, `${name}-1-empty`);

    await load(page, true);
    await page.waitForTimeout(6_000);
    await shot(page, `${name}-2-transcript`, name === 'narrow');

    // Two manual markers give populated moment cards on every viewport (the heads-up needs the scripted EEG, below).
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: /Mark this moment/ }).click();
      await page.waitForTimeout(2_200);
    }
    await page.getByRole('tab', { name: /Moments/ }).click();
    await shot(page, `${name}-3-moments`, name === 'narrow');

    await page.getByRole('tab', { name: /Attention/ }).click();
    await page.waitForTimeout(500);
    await shot(page, `${name}-4-attention`, name === 'narrow');

    await page.getByRole('button', { name: 'Session setup' }).click();
    await page.waitForTimeout(300);
    await shot(page, `${name}-5-setup`);
    await page.getByRole('button', { name: 'Calibrate gaze' }).click();
    await page.waitForTimeout(2_500);
    if (await page.getByRole('dialog', { name: 'Gaze calibration' }).count()) {
      await shot(page, `${name}-6-calibration-dot`);
      // The target must sit at its viewport coordinates: no ancestor transform may displace it.
      const geometry = await page.evaluate(() => {
        const dot = document.querySelector('.calibration-dot') as HTMLElement;
        const r = dot.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: parseFloat(dot.style.left), top: parseFloat(dot.style.top) };
      });
      expect(Math.abs(geometry.cx - geometry.left)).toBeLessThan(2);
      expect(Math.abs(geometry.cy - geometry.top)).toBeLessThan(2);
      await page.getByRole('button', { name: 'Cancel calibration' }).click();
    }
    await page.getByRole('button', { name: 'Back to lecture' }).click();

    if (name !== 'laptop') {
      await page.getByRole('tab', { name: /Moments/ }).click();
      await expect(page.getByTestId('review-reminder')).toHaveCount(1, { timeout: 120_000 });
      await page.waitForTimeout(600);
      await shot(page, `${name}-7-headsup`, name === 'narrow');
    }
  });
}

test('screenshots camera blocked', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  });
  await openApp(page);
  await load(page, false);
  await page.getByRole('button', { name: 'Session setup' }).click();
  await page.getByRole('button', { name: 'Calibrate gaze' }).click();
  await expect(page.getByTestId('gaze-status')).toHaveAttribute('data-failure', 'permission');
  await expect(page.getByTestId('gaze-status')).toContainText(/blocked/i);
  await shot(page, 'desktop-8-camera-blocked');
});

test('an unrecognised camera failure is not presented as a permission problem', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Constraint could not be satisfied'), { name: 'OverconstrainedError' }));
  });
  await openApp(page);
  await load(page, false);
  await page.getByRole('button', { name: 'Session setup' }).click();
  await page.getByRole('button', { name: 'Calibrate gaze' }).click();
  const status = page.getByTestId('gaze-status');
  await expect(status).toHaveAttribute('data-failure', 'unknown');
  await expect(status).toContainText('could not be identified');
  await expect(status).not.toContainText(/blocked/i);
});

test('screenshots maximised and empty drag', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await load(page, true);
  await page.waitForTimeout(3_000);
  await page.getByRole('button', { name: 'Maximise player' }).click();
  await page.waitForTimeout(500);
  await shot(page, 'desktop-9-maximised');
});

/** Same lecture, viewport and populated review state under both visual treatments (?design=brutal is variation B). */
for (const design of ['current', 'brutal'] as const) {
  test(`compare loaded screen: ${design}`, async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const token = readFileSync('frontend/test-results/shots-token', 'utf8').trim();
    await page.goto(`${SHOTS_URL}/${design === 'brutal' ? '?design=brutal' : ''}#pair=${token}`);
    await expect(page.getByText('Session connected')).toBeVisible();
    await load(page, true);
    await page.getByRole('tab', { name: /Moments/ }).click();
    await expect(page.getByTestId('review-reminder')).toHaveCount(1, { timeout: 120_000 });
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 20; });
    await page.waitForTimeout(500);
    await shot(page, `compare-${design}-moments-headsup`);
    await page.getByRole('tab', { name: /Transcript/ }).click();
    await page.waitForTimeout(400);
    await shot(page, `compare-${design}-transcript`);
    await page.getByRole('tab', { name: /Attention/ }).click();
    await page.waitForTimeout(400);
    await shot(page, `compare-${design}-attention`);
  });
}
