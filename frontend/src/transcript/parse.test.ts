import { describe, expect, it } from 'vitest';
import { parseTimestamp, parseTranscript, TranscriptParseError } from './parse';

const VTT = `WEBVTT
Kind: captions

NOTE This is a comment
that spans lines

STYLE
::cue { color: yellow }

1
00:00:01.000 --> 00:00:04.000 align:start position:0%
<v Prof. Smith>Welcome to the <i>lecture</i> &amp; thanks.</v>

00:04.000 --> 00:07.500
Today we cover
action potentials.
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome to the lecture.

2
00:00:04,000 --> 00:00:07,500
{\\an8}Today we cover action potentials.
`;

describe('parseTimestamp', () => {
  it('reads hh:mm:ss.mmm, mm:ss.mmm and SRT commas', () => {
    expect(parseTimestamp('01:02:03.456')).toBeCloseTo(3723.456);
    expect(parseTimestamp('02:03.5')).toBeCloseTo(123.5);
    expect(parseTimestamp('00:00:01,000')).toBe(1);
  });
  it('rejects malformed values', () => {
    expect(parseTimestamp('1.5')).toBeNull();
    expect(parseTimestamp('00:61:00.000')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
  });
});

describe('parseTranscript', () => {
  it('parses WebVTT with notes, styles, settings, voice tags and entities', () => {
    const t = parseTranscript(VTT, 'lecture.vtt');
    expect(t.format).toBe('vtt');
    expect(t.cues).toEqual([
      { index: 0, startS: 1, endS: 4, text: 'Welcome to the lecture & thanks.' },
      { index: 1, startS: 4, endS: 7.5, text: 'Today we cover action potentials.' },
    ]);
    expect(t.warnings).toEqual([]);
  });

  it('parses SRT, CRLF line endings and a BOM', () => {
    const t = parseTranscript('\uFEFF' + SRT.replace(/\n/g, '\r\n'), 'lecture.srt');
    expect(t.format).toBe('srt');
    expect(t.cues.map((c) => c.text)).toEqual(['Welcome to the lecture.', 'Today we cover action potentials.']);
  });

  it('skips bad cues with warnings but keeps good ones', () => {
    const t = parseTranscript(
      `WEBVTT

00:00:01.000 --> 00:00:02.000
Good.

00:00:05.000 --> 00:00:03.000
Backwards.

00:00:xx.000 --> 00:00:09.000
Bad time.

Loose text with no timing
`,
      'x.vtt',
    );
    expect(t.cues.map((c) => c.text)).toEqual(['Good.']);
    expect(t.warnings).toHaveLength(3);
  });

  it('sorts out-of-order cues and says so', () => {
    const t = parseTranscript(`1\n00:00:05,000 --> 00:00:06,000\nB.\n\n2\n00:00:01,000 --> 00:00:02,000\nA.\n`);
    expect(t.cues.map((c) => c.text)).toEqual(['A.', 'B.']);
    expect(t.warnings[0]).toMatch(/out of order/);
  });

  it('removes rolling duplicate lines from auto-generated captions', () => {
    const t = parseTranscript(`WEBVTT

00:00:00.000 --> 00:00:02.000
so today we're going to

00:00:02.000 --> 00:00:02.010
so today we're going to

00:00:02.010 --> 00:00:04.000
so today we're going to
<00:00:02.500><c>talk</c><00:00:03.000><c> about neurons</c>
`);
    expect(t.cues.map((c) => c.text)).toEqual(["so today we're going to", 'talk about neurons']);
  });

  it('throws a readable error for empty, non-caption and headerless VTT files', () => {
    expect(() => parseTranscript('', 'a.vtt')).toThrow(/empty/);
    expect(() => parseTranscript('just some notes\nabout the lecture', 'notes.srt')).toThrow(TranscriptParseError);
    expect(() => parseTranscript('00:00:01.000 --> 00:00:02.000\nHi', 'a.vtt')).toThrow(/WEBVTT/);
  });
});
