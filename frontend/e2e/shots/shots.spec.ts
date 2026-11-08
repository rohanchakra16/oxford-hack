/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { SHOTS_URL } from '../shots.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

/**
 * Not a regression test: captures screenshots of the real main app on the scripted TEST EEG source
 * (see docs/design/README.md). `SHOT_TAG=after npx playwright test -c e2e/shots.config.ts`.
 */
const tag = process.env.SHOT_TAG ?? 'adhoc';
const out = `docs/design/${tag}`;
const VTT = ['WEBVTT', '', ...Array.from({ length: 12 }, (_, k) => {
  const mm = (s: number) => `00:${String(s).padStart(2, '0')}.000`;
  return `${mm(k * 5)} --> ${mm((k + 1) * 5)}\nSentence number ${k + 1} explains topic ${k + 1} of this short rehearsal lecture.\n`;
})].join('\n');

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['narrow', { width: 390, height: 844 }]] as const) {
  test(`screenshots ${name}`, async ({ page }) => {
    test.setTimeout(150_000);
    mkdirSync(out, { recursive: true });
    await page.setViewportSize(viewport);
    const lecture = await makeSyntheticLecture();
    const token = readFileSync('frontend/test-results/shots-token', 'utf8').trim();
    await page.goto(`${SHOTS_URL}/#pair=${token}`);
    await expect(page.getByText('Session connected')).toBeVisible();
    await page.screenshot({ path: `${out}/${name}-1-empty.png`, fullPage: true });
    await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
    await page.locator('input[type="file"][accept*=".vtt"]').setInputFiles({ name: 'lecture.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
    await expect(page.getByText('Sentence number 3 explains topic 3', { exact: false })).toBeVisible();
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.loop = true; return v.play(); });
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: `${out}/${name}-2-playing.png`, fullPage: true });
    await expect(page.getByTestId('review-reminder')).toHaveCount(1, { timeout: 90_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${name}-3-reminder.png`, fullPage: true });
  });
}
