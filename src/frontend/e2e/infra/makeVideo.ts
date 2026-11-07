import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

/** The ffmpeg that `playwright install chromium` puts next to the browsers (a stripped build: VP9 only). */
function playwrightFfmpeg(): string {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (platform() === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : platform() === 'win32'
        ? join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'));
  const dir = readdirSync(root).filter((d) => d.startsWith('ffmpeg-')).sort().at(-1);
  if (!dir) throw new Error('Playwright ffmpeg not found; run: npx playwright install chromium');
  const exe = readdirSync(join(root, dir)).find((f) => /^ffmpeg-(mac|linux|win64)/.test(f));
  if (!exe) throw new Error(`no ffmpeg binary in ${join(root, dir)}`);
  return join(root, dir, exe);
}

export const LECTURE_WEBM = 'test-results/synthetic-lecture.webm';
export const LECTURE_SECONDS = 40;

/**
 * Builds a 40 s synthetic WebM (flat colour, no people, no audio) with the ffmpeg Playwright already
 * ships, from one JPEG frame rendered by Chromium (this stripped ffmpeg build only demuxes image2pipe and has no pipe/lavfi inputs, so frames go through a file). Generated into git-ignored test-results/ and never committed.
 */
export async function makeSyntheticLecture(): Promise<string> {
  if (existsSync(LECTURE_WEBM)) return LECTURE_WEBM;
  mkdirSync(dirname(LECTURE_WEBM), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await page.setContent('<body style="margin:0;background:#1f4e79"></body>');
  const jpeg = await page.screenshot({ type: 'jpeg' });
  await browser.close();
  const fps = 5;
  const frames = 'test-results/synthetic-frames.mjpeg'; // concatenated JPEGs, one per frame
  writeFileSync(frames, Buffer.concat(Array.from({ length: fps * LECTURE_SECONDS }, () => jpeg)));
  const ffmpeg = playwrightFfmpeg();
  const run = spawnSync(
    ffmpeg,
    ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', frames, '-c:v', 'libvpx-vp9', '-b:v', '50k', '-pix_fmt', 'yuv420p', LECTURE_WEBM],
    { maxBuffer: 1 << 28 },
  );
  if (run.status !== 0) {
    writeFileSync('test-results/ffmpeg.log', run.stderr);
    throw new Error('ffmpeg failed to build the synthetic lecture; see test-results/ffmpeg.log');
  }
  return LECTURE_WEBM;
}
