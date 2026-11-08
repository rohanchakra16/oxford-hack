import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

/** A bright, slide-like synthetic lecture for judging glass legibility. Built into git-ignored test-results/. */
export const SLIDE_WEBM = 'test-results/slide-lecture.webm';

function ffmpegPath(): string {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (platform() === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  const dir = readdirSync(root).filter((d) => d.startsWith('ffmpeg-')).sort().at(-1)!;
  return join(root, dir, readdirSync(join(root, dir)).find((f) => /^ffmpeg-(mac|linux|win64)/.test(f))!);
}

const slide = (title: string, bullets: string[], accent: string) => `<body style="margin:0;width:960px;height:540px;background:#fbfbf8;font-family:Georgia,serif;color:#1d2330;position:relative;overflow:hidden">
<div style="position:absolute;left:0;top:0;right:0;height:14px;background:${accent}"></div>
<h1 style="position:absolute;left:64px;top:56px;margin:0;font-size:46px;font-weight:700">${title}</h1>
<ul style="position:absolute;left:64px;top:170px;margin:0;padding-left:28px;font-size:27px;line-height:1.7;width:520px">${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
<svg style="position:absolute;right:56px;top:150px" width="300" height="300"><circle cx="150" cy="150" r="120" fill="none" stroke="${accent}" stroke-width="14"/><path d="M60 190 L120 120 L170 160 L240 80" fill="none" stroke="#1d2330" stroke-width="9"/></svg>
<div style="position:absolute;left:64px;bottom:34px;font-size:18px;color:#6a7080">Signals and Systems · Lecture 4</div></body>`;

export async function makeSlideLecture(): Promise<string> {
  if (existsSync(SLIDE_WEBM)) return SLIDE_WEBM;
  mkdirSync(dirname(SLIDE_WEBM), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const jpegs: Buffer[] = [];
  for (const [t, b, a] of [
    ['Sampling and aliasing', ['Sample faster than twice the bandwidth', 'Below that, frequencies fold back', 'Filter before you sample'], '#2552d4'],
    ['The Fourier transform', ['Any signal is a sum of sinusoids', 'Magnitude shows how much of each', 'Phase shows where each one starts'], '#e5791a'],
  ] as const) {
    await page.setContent(slide(t, [...b], a));
    jpegs.push(await page.screenshot({ type: 'jpeg', quality: 80 }));
  }
  await browser.close();
  const fps = 4;
  const frames = 'test-results/slide-frames.mjpeg';
  writeFileSync(frames, Buffer.concat(Array.from({ length: fps * 40 }, (_, i) => jpegs[i < fps * 20 ? 0 : 1]!)));
  const run = spawnSync(ffmpegPath(), ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', frames, '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', SLIDE_WEBM], { maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error('ffmpeg failed to build the slide lecture');
  return SLIDE_WEBM;
}
