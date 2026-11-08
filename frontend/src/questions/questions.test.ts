import { describe, expect, it, vi } from 'vitest';
import type { Sentence } from '../transcript';
import { requestQuestion, type QuestionOutcome } from './client';
import { excerptForBookmark, type BookmarkRange } from './excerpt';
import { createQuestionStore } from './store';

const s = (index: number, startS: number, endS: number, text: string): Sentence => ({ index, startS, endS, text, cueIndices: [index] });
const SENTENCES = [
  s(0, 0, 10, 'Welcome back.'),
  s(1, 30, 40, 'Ohm’s law links voltage, current and resistance.'),
  s(2, 40, 50, 'At a fixed voltage, current falls as resistance rises.'),
  s(3, 50, 60, 'Next we look at power.'),
  s(4, 60, 70, 'Power is voltage times current.'),
];
const bookmark = (over: Partial<BookmarkRange> = {}): BookmarkRange => ({
  bookmarkId: 'b1', videoId: 'v1', suggestedMediaS: 42, evidenceMedia: { startMediaS: 45, endMediaS: 52 }, ...over,
});

describe('excerptForBookmark', () => {
  it('uses lead context and completes a sentence crossing the evidence end', () => {
    const e = excerptForBookmark(SENTENCES, bookmark())!;
    expect(e.text).toBe('Ohm’s law links voltage, current and resistance. At a fixed voltage, current falls as resistance rises. Next we look at power.');
    expect(e.text).not.toContain('Power is voltage times current');
    expect([e.startMediaS, e.endMediaS]).toEqual([30, 60]);
  });
  it('manual bookmarks look back from the mark', () => {
    const e = excerptForBookmark(SENTENCES, bookmark({ evidenceMedia: null, suggestedMediaS: 45 }), { leadS: 0 })!;
    expect(e.text.startsWith('Ohm’s law')).toBe(true);
    expect(e.text).not.toContain('Next we look');
  });
  it('drops the earliest context first to fit the size cap', () => {
    const e = excerptForBookmark(SENTENCES, bookmark(), { maxChars: 80, hardMaxChars: 80 })!;
    expect(e.text).toBe('At a fixed voltage, current falls as resistance rises. Next we look at power.');
  });
  it('returns null with no overlapping speech', () => {
    expect(excerptForBookmark(SENTENCES, bookmark({ evidenceMedia: { startMediaS: 200, endMediaS: 210 } }))).toBeNull();
  });
  const textOfLength = (length: number) => `${'x'.repeat(length - 1)}.`;
  it('allows complete sentences past 3000, up to the 3500 hard limit', () => {
    const sentences = [s(0, 0, 10, textOfLength(400)), s(1, 10, 20, textOfLength(1400)), s(2, 20, 30, textOfLength(1400))];
    const e = excerptForBookmark(sentences, bookmark({ evidenceMedia: { startMediaS: 0, endMediaS: 30 } }))!;
    expect(e.text).toBe(sentences.map((sentence) => sentence.text).join(' '));
    expect(e.text.length).toBe(3202);
    expect([e.startMediaS, e.endMediaS]).toEqual([0, 30]);
  });
  it('drops an earlier whole sentence when adding it would exceed 3500', () => {
    const sentences = [s(0, 0, 10, textOfLength(800)), s(1, 10, 20, textOfLength(1400)), s(2, 20, 30, textOfLength(1400))];
    const e = excerptForBookmark(sentences, bookmark({ evidenceMedia: { startMediaS: 0, endMediaS: 30 } }))!;
    expect(e.text).toBe(sentences.slice(1).map((sentence) => sentence.text).join(' '));
    expect(e.startMediaS).toBe(10);
  });
  it('keeps a single 3500-character sentence intact and refuses a longer one', () => {
    const b = bookmark({ evidenceMedia: { startMediaS: 0, endMediaS: 10 } });
    expect(excerptForBookmark([s(0, 0, 10, textOfLength(3500))], b)?.text.length).toBe(3500);
    expect(excerptForBookmark([s(0, 0, 10, textOfLength(3501))], b)).toBeNull();
  });
  it('does not jump over an oversized target sentence to ask about earlier context', () => {
    const b = bookmark({ evidenceMedia: { startMediaS: 10, endMediaS: 20 } });
    expect(excerptForBookmark([s(0, 0, 10, 'Earlier concept.'), s(1, 10, 20, textOfLength(3501))], b)).toBeNull();
  });
});

const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const EX = { startMediaS: 30, endMediaS: 60, text: 'x' };

describe('requestQuestion', () => {
  it('sends the excerpt with the launch token and parses a ready question', async () => {
    const fetchImpl = ok({ status: 'ready', question: 'Q?', suggestedAnswer: 'A.', supportingQuote: 'q', quoteVerified: true, model: 'm', promptVersion: 'p', cached: false });
    const out = await requestQuestion(bookmark(), EX, { backendUrl: 'http://b', launchToken: 'tok', fetchImpl });
    expect(out).toMatchObject({ status: 'ready', result: { question: 'Q?', quoteVerified: true } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://b/api/v0/questions');
    expect(init.headers['x-launch-token']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ bookmarkId: 'b1', videoId: 'v1', ...EX });
  });
  it('maps rate limits and missing pairing to unavailable', async () => {
    const limited = await requestQuestion(bookmark(), EX, { backendUrl: 'b', launchToken: 't', fetchImpl: ok({ error: 'rate_limited', message: 'Free limit', retryAfterS: 30 }, 429) });
    expect(limited).toEqual({ status: 'unavailable', code: 'rate_limited', message: 'Free limit', retryAfterS: 30 });
    const unpaired = await requestQuestion(bookmark(), EX, { backendUrl: 'b', launchToken: null });
    expect(unpaired).toMatchObject({ status: 'unavailable', code: 'not_paired' });
  });
  it('treats a network failure as unavailable, not a crash', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await requestQuestion(bookmark(), EX, { backendUrl: 'b', launchToken: 't', fetchImpl })).toMatchObject({ code: 'network' });
  });
});

const ready: QuestionOutcome = { status: 'ready', result: { question: 'Q?', suggestedAnswer: 'A', supportingQuote: '', quoteVerified: false, model: 'm', promptVersion: 'p', cached: false } };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createQuestionStore', () => {
  it('is generating immediately, ready later, and requests once per bookmark', async () => {
    const request = vi.fn(async () => ready);
    const store = createQuestionStore(request);
    store.reset('v1');
    store.ensure(bookmark(), SENTENCES);
    expect(store.getSnapshot().get('b1')?.status).toBe('generating');
    store.ensure(bookmark(), SENTENCES);
    await flush();
    expect(store.getSnapshot().get('b1')?.status).toBe('ready');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('marks no transcript without calling the backend, and retries when one arrives', async () => {
    const request = vi.fn(async () => ready);
    const store = createQuestionStore(request);
    store.ensure(bookmark(), null);
    expect(store.getSnapshot().get('b1')?.status).toBe('no_transcript');
    expect(request).not.toHaveBeenCalled();
    store.retry(bookmark(), SENTENCES);
    await flush();
    expect(store.getSnapshot().get('b1')?.status).toBe('ready');
  });
  it('discards a late response after the lecture changes', async () => {
    let resolve: (o: QuestionOutcome) => void = () => {};
    const store = createQuestionStore(() => new Promise((r) => { resolve = r; }));
    store.reset('v1');
    store.ensure(bookmark(), SENTENCES);
    store.reset('v2');
    resolve(ready);
    await flush();
    expect(store.getSnapshot().size).toBe(0);
  });
  it('ignores bookmarks from another lecture', () => {
    const store = createQuestionStore(vi.fn(async () => ready));
    store.reset('v2');
    store.ensure(bookmark(), SENTENCES);
    expect(store.getSnapshot().size).toBe(0);
  });
  it('keeps unavailable results retryable', async () => {
    const request = vi.fn<() => Promise<QuestionOutcome>>()
      .mockResolvedValueOnce({ status: 'unavailable', code: 'timeout', message: 'slow', retryAfterS: null })
      .mockResolvedValueOnce(ready);
    const store = createQuestionStore(request);
    store.ensure(bookmark(), SENTENCES);
    await flush();
    expect(store.getSnapshot().get('b1')?.status).toBe('unavailable');
    store.retry(bookmark(), SENTENCES);
    await flush();
    expect(store.getSnapshot().get('b1')?.status).toBe('ready');
  });
});
