import { describe, expect, it } from 'vitest';
import { formatTime, parseTranscript, replayPassage } from './transcript';

describe('parseTranscript', () => {
  it('reads WebVTT cues and removes inline caption markup', () => {
    const cues = parseTranscript(`WEBVTT

00:00:01.250 --> 00:00:03.500
<v Lecturer>Welcome &amp; settle in.</v>

00:00:03.500 --> 00:00:06.000
Let us begin.
`);

    expect(cues).toEqual([
      { startS: 1.25, endS: 3.5, text: 'Welcome & settle in.' },
      { startS: 3.5, endS: 6, text: 'Let us begin.' },
    ]);
  });

  it('reads SRT cues with comma-separated milliseconds', () => {
    expect(parseTranscript(`1
00:01:02,100 --> 00:01:04,250
An important definition.
`)).toEqual([
      { startS: 62.1, endS: 64.25, text: 'An important definition.' },
    ]);
  });

  it('ignores malformed or empty cues', () => {
    expect(parseTranscript(`00:00:04.000 --> 00:00:02.000
Backwards.

00:00:05.000 --> 00:00:06.000
`)).toEqual([]);
  });
});

describe('replayPassage', () => {
  const cues = [
    { startS: 4, endS: 8, text: 'First idea.' },
    { startS: 8, endS: 13, text: 'Second idea.' },
    { startS: 13, endS: 18, text: 'Third idea.' },
  ];

  it('selects the caption containing the conservative suggestion time', () => {
    expect(replayPassage(cues, 10)).toMatchObject({ index: 1, startS: 8, text: 'Second idea.' });
  });

  it('steps back one caption at a time and clamps at the beginning', () => {
    expect(replayPassage(cues, 15, 1)).toMatchObject({ index: 1, startS: 8 });
    expect(replayPassage(cues, 15, 20)).toMatchObject({ index: 0, startS: 4 });
  });

  it('uses the closest preceding caption when the suggestion falls between cues', () => {
    expect(replayPassage(cues, 11.5)).toMatchObject({ index: 1, startS: 8 });
    expect(replayPassage(cues, 2)).toMatchObject({ index: 0, startS: 4 });
    expect(replayPassage(cues, 30)).toMatchObject({ index: 2, startS: 13 });
  });

  it('formats timestamps for the player and review markers', () => {
    expect(formatTime(65.8)).toBe('1:05');
    expect(formatTime(3665)).toBe('1:01:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });
});
