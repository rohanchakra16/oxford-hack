import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { readFileSync } from 'node:fs';
import { MAIN_URL } from '../../frontend/e2e/main-eeg.config';
import { makeSyntheticLecture } from '../../frontend/e2e/infra/makeVideo';

test('main live website sends calibrated gaze to backend and saves a real-transport combined bookmark', async ({ page }) => {
  test.setTimeout(70_000);
  const lecture = await makeSyntheticLecture();
  const token = readFileSync('frontend/test-results/main-eeg-token', 'utf8').trim();
  const sent: string[] = [], received: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => { try { sent.push(JSON.parse(String(payload)).type); } catch { /* transport */ } });
    ws.on('framereceived', ({ payload }) => {
      try { const m = JSON.parse(String(payload)); if (m.type === 'review_bookmark') received.push(m.payload.source); } catch { /* transport */ }
    });
  });
  let evaluationCalls = 0;
  await page.route('**/evaluation-api/**', (route) => { evaluationCalls++; return route.abort(); });
  // Camera fixture only. Live backend/source fixture, clock synchronization,
  // gaze transport, signal combination and media mapping are real code paths.
  await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    export function createGazeCamera(o) {let timer;return {
      start:async()=>{},
      calibrate:async()=>{
        o.onCalibration({id:'live-camera-test',status:'valid',contract:{
          calibrationId:'live-camera-test',status:'valid',measurementKind:'screen_gaze',
          method:'controlled browser fixture',fitPoints:9,heldOutPoints:4,heldOutErrorNorm:0.02,
          viewportCssPx:{x:0,y:0,width:1000,height:800},videoRectCssPx:{x:0,y:0,width:800,height:450},
          invalidatedReason:null,tBrowserMs:performance.now()
        }});
        timer=setInterval(()=>{const t=performance.now();const f={observationId:'frame-'+t,
          tBrowserFrameMs:t,tBrowserProcessedMs:t,measurementKind:'screen_gaze',calibrationId:'live-camera-test',
          valid:true,invalidReasons:[],insideVideo:o.getVideoElement().currentTime<14,
          videoPoint:{x:0.5,y:0.5},modelConfidence:0.9};o.onObservation(f);o.onObservationBatch?.([f]);},100);
      },getCalibration:()=>null,stop:()=>clearInterval(timer)
    }}
  ` }));
  await page.goto(`${MAIN_URL}/#pair=${token}`);
  await expect(page.getByText('Session connected')).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate EEG + gaze' }).click();
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(10);
  await expect(page.locator('article.bookmark-card')).toHaveCount(0);
  await expect(page.getByTestId('review-reminder')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('article.bookmark-card')).toHaveCount(1);
  expect(received).toEqual(['experimental_combined']);
  expect(sent).toContain('gaze_calibration'); expect(sent).toContain('gaze_observations');
  expect(evaluationCalls).toBe(0);
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await expect(page.getByText('Camera stopped.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await expect(page.locator('article.bookmark-card')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Saved bookmark flags' }).getByRole('button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(20);
  await page.screenshot({ path: 'test-results/live-combined/main-live.png', fullPage: true });
});
