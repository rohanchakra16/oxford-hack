/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from '../../playwright.config';
import { LECTURE_SECONDS, makeSyntheticLecture } from './makeVideo';
import { backendState, launchToken } from './helpers';

/**
 * Product-level tests of the composed lecture UI (Betty's design on Aryan's LecturePlayer/TranscriptPanel and the
 * shared ReviewClient). Default adapter is the explicitly SYNTHETIC one, because it supplies suggestions; the
 * live-adapter test checks the single telemetry path against the real backend.
 */
const SENTENCE_S = 5;
const VTT = [
  'WEBVTT',
  '',
  ...Array.from({ length: 8 }, (_, k) => {
    const mm = (s: number) => `00:${String(s).padStart(2, '0')}.000`;
    return `${mm(k * SENTENCE_S)} --> ${mm((k + 1) * SENTENCE_S)}\nSentence number ${k + 1} explains topic ${k + 1}.\n`;
  }),
].join('\n');

let lecture: string;
test.beforeAll(async () => {
  lecture = await makeSyntheticLecture();
});

const videoTime = (page: Page) => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
const videoPaused = (page: Page) => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused);

async function openLecture(page: Page, url: string) {
  await page.goto(url);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
  await page.locator('input[type="file"][accept*=".vtt"]').setInputFiles({ name: 'lecture.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
  await expect(page.getByText('Sentence number 3 explains topic 3.')).toBeVisible();
}

test('product app loads, is labelled as a simulation, and states what suggestions are', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/?adapter=synthetic`);
  await expect(page.getByText('Simulation mode')).toBeVisible();
  await expect(page.getByText(/not real attention measurements/i)).toBeVisible();
  await expect(page.getByText(/suggestions to review, not judgments about your attention/i)).toBeVisible();
  await expect(page.getByText('No review moments yet')).toBeVisible();
});

test('transcript sentences follow playback and clicking one seeks to its start', async ({ page }) => {
  await openLecture(page, `${FRONTEND_URL}/?adapter=synthetic`);
  await page.getByText('Sentence number 4 explains topic 4.').click();
  await expect.poll(() => videoTime(page)).toBeCloseTo(3 * SENTENCE_S, 0);
});

test('a suggestion replays from its sentence start, bounded to that sentence; Move earlier steps back one sentence', async ({ page }) => {
  test.setTimeout(90_000);
  await openLecture(page, `${FRONTEND_URL}/?adapter=synthetic`);
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 6; v.play(); });
  const card = page.locator('article.bookmark-card').first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());

  const suggested = Number(/PT([\d.]+)S/.exec((await card.locator('time').getAttribute('datetime'))!)![1]);
  const k = Math.floor(suggested / SENTENCE_S);
  await expect(card.locator('h3')).toHaveText(`Sentence number ${k + 1} explains topic ${k + 1}.`);

  await card.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => videoTime(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(k * SENTENCE_S - 0.1);
  await expect.poll(() => videoPaused(page), { timeout: 15_000 }).toBe(true); // bounded: stops at the sentence end
  expect(await videoTime(page)).toBeLessThan((k + 1) * SENTENCE_S + 3.6);

  if (k > 0) {
    await card.getByRole('button', { name: /Move replay earlier/ }).click();
    await expect(card.locator('h3')).toHaveText(`Sentence number ${k} explains topic ${k}.`);
    await card.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect.poll(() => videoTime(page), { timeout: 5_000 }).toBeLessThan(k * SENTENCE_S);
  }

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card.getByText('Dismissed for this view')).toBeVisible();
});

test('without a transcript a suggestion falls back to its own time and keeps playing', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${FRONTEND_URL}/?adapter=synthetic`);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 6; v.play(); });
  const card = page.locator('article.bookmark-card').first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  const suggested = Number(/PT([\d.]+)S/.exec((await card.locator('time').getAttribute('datetime'))!)![1]);
  await card.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => videoTime(page), { timeout: 5_000 }).toBeLessThan(suggested + 2);
  await expect.poll(() => videoPaused(page)).toBe(false);
});

test('live adapter: one telemetry path and one session reach the real backend', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/#pair=${launchToken()}`);
  await expect(page.getByText('Session connected')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => videoTime(page), { timeout: 10_000 }).toBeGreaterThan(1.5);
  await expect
    .poll(async () => (await backendState()).sessions.filter((s) => s.connected && s.runKind === 'live').length, { timeout: 10_000 })
    .toBe(1);
  const s = (await backendState()).sessions.find((x) => x.connected && x.runKind === 'live')!;
  expect(s.segments.length).toBeGreaterThanOrEqual(1);
  expect(s.videoId).toMatch(/^local-[0-9a-f]{16}$/);
});
