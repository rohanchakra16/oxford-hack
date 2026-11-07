import { describe, expect, it } from 'vitest';
import type { Cue } from './parse';
import { buildSentences, replayStartFor, sentenceIndexAt, toTranscriptContext } from './sentences';
import { durationMismatch, loadTranscriptFile, transcriptFromText } from './load';

const cue = (index: number, startS: number, endS: number, text: string): Cue => ({ index, startS, endS, text });

describe('buildSentences', () => {
  it('merges cues that split a sentence', () => {
    const s = buildSentences([cue(0, 0, 2, 'Today we cover'), cue(1, 2, 4, 'action potentials.')]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ startS: 0, endS: 4, text: 'Today we cover action potentials.', cueIndices: [0, 1] });
  });

  it('splits a cue containing two sentences, timing the boundary by character position', () => {
    // 'One two. Three four.' -> boundary after 'One two.' (8 of 20 chars) => 10 + 10 * 8/20 = 14
    const s = buildSentences([cue(0, 10, 20, 'One two. Three four.')]);
    expect(s.map((x) => x.text)).toEqual(['One two.', 'Three four.']);
    expect(s[0]!.endS).toBeCloseTo(14);
    expect(s[1]!.startS).toBeCloseTo(14.5); // after the space
    expect(s[1]!.endS).toBeCloseTo(20);
  });

  it('handles ? ! … and closing quotes', () => {
    const s = buildSentences([cue(0, 0, 9, 'Why? Because! He said "stop." Then… silence.')]);
    expect(s.map((x) => x.text)).toEqual(['Why?', 'Because!', 'He said "stop."', 'Then…', 'silence.']);
  });

  it('does not split at abbreviations or decimals', () => {
    const s = buildSentences([cue(0, 0, 9, 'See e.g. Fig. 3 by Dr. Smith, about 3.5 mV, vs. rest.')]);
    expect(s).toHaveLength(1);
  });

  it('falls back to pauses and a maximum length when there is no punctuation', () => {
    const s = buildSentences([
      cue(0, 0, 3, 'so the neuron fires'),
      cue(1, 3, 6, 'and then it rests'),
      cue(2, 9, 12, 'next topic is synapses'), // 3 s gap
    ]);
    expect(s.map((x) => x.text)).toEqual(['so the neuron fires and then it rests', 'next topic is synapses']);

    const long = Array.from({ length: 12 }, (_, i) => cue(i, i * 3, i * 3 + 3, `words ${i}`));
    const chunks = buildSentences(long, { maxSentenceS: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.endS - c.startS).toBeLessThanOrEqual(21);
  });

  it('numbers sentences in order', () => {
    const s = buildSentences([cue(0, 0, 2, 'A. B.'), cue(1, 2, 4, 'C.')]);
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
  });
});

describe('navigation helpers', () => {
  const sentences = buildSentences([cue(0, 5, 10, 'First.'), cue(1, 10, 15, 'Second.'), cue(2, 20, 25, 'Third.')]);

  it('sentenceIndexAt: last started sentence, -1 before the first', () => {
    expect(sentenceIndexAt(sentences, 0)).toBe(-1);
    expect(sentenceIndexAt(sentences, 5)).toBe(0);
    expect(sentenceIndexAt(sentences, 12)).toBe(1);
    expect(sentenceIndexAt(sentences, 17)).toBe(1); // pause in speech: previous stays current
    expect(sentenceIndexAt(sentences, 99)).toBe(2);
    expect(sentenceIndexAt([], 10)).toBe(-1);
  });

  it('replayStartFor: sentence start, moved earlier by whole sentences', () => {
    expect(replayStartFor(sentences, 22)).toBe(20);
    expect(replayStartFor(sentences, 22, 1)).toBe(10);
    expect(replayStartFor(sentences, 22, 5)).toBe(5); // clamps at the first sentence
    expect(replayStartFor(sentences, 2)).toBe(2); // before any speech
    expect(replayStartFor([], 42)).toBe(42); // no transcript
  });

  it('toTranscriptContext matches the shared contract shape', () => {
    expect(toTranscriptContext(sentences[1]!)).toEqual({ startMediaS: 10, endMediaS: 15, text: 'Second.' });
  });
});

describe('loading', () => {
  const file = (name: string, body: string) => ({ name, size: body.length, text: () => Promise.resolve(body) });

  it('loads a caption file into cues and sentences', async () => {
    const r = await loadTranscriptFile(file('l.srt', '1\n00:00:01,000 --> 00:00:03,000\nHello there. General Kenobi.\n'));
    expect(r.ok && r.transcript.sentences.map((s) => s.text)).toEqual(['Hello there.', 'General Kenobi.']);
  });

  it('rejects the wrong file type, empty and unparseable files with a message', async () => {
    expect(await loadTranscriptFile(file('l.pdf', 'x'))).toMatchObject({ ok: false });
    expect(await loadTranscriptFile(file('l.vtt', ''))).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    expect(await loadTranscriptFile(file('l.srt', 'no captions here'))).toMatchObject({ ok: false });
  });

  it('flags a transcript that runs well past the end of the video', () => {
    const r = transcriptFromText('1\n00:10:00,000 --> 00:10:05,000\nLate.\n', 'l.srt');
    if (!r.ok) throw new Error('expected ok');
    expect(durationMismatch(r.transcript, 120)).toMatch(/different lecture/);
    expect(durationMismatch(r.transcript, 700)).toBeNull();
    expect(durationMismatch(r.transcript, null)).toBeNull();
  });
});
