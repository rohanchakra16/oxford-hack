import { describe, expect, it } from 'vitest';
import type { Sentence } from '../transcript';
import { planReplay } from './replayPlan';

const sentence = (startS: number, endS: number): Sentence => ({ startS, endS, text: `s${startS}` }) as Sentence;
const sentences = [sentence(0, 4), sentence(4, 9), sentence(9, 20)];

describe('planReplay', () => {
  it('starts at the containing sentence and ends with it', () => {
    expect(planReplay(sentences, { suggestedMediaS: 5 }, 0, 100)).toEqual({ startS: 4, endS: 9 });
  });

  it('moves earlier by whole sentences', () => {
    expect(planReplay(sentences, { suggestedMediaS: 10 }, 1, 100)).toEqual({ startS: 4, endS: 20 });
  });

  it('keeps a three second minimum within the media', () => {
    expect(planReplay([sentence(0, 1)], { suggestedMediaS: 0.5 }, 0, 100)).toEqual({ startS: 0, endS: 3 });
    expect(planReplay([sentence(0, 1)], { suggestedMediaS: 0.5 }, 0, 2)).toEqual({ startS: 0, endS: 2 });
  });

  it('without a transcript uses the finished segment end', () => {
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: 16 }, 0, 100)).toEqual({ startS: 10, endS: 16 });
  });

  it('without a transcript or an end seeks and keeps playing (unfinished segment)', () => {
    expect(planReplay([], { suggestedMediaS: 10 }, 0, 100)).toEqual({ startS: 10, endS: null });
  });

  it('falls back to seek-and-play for zero-length and reversed ranges', () => {
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: 10 }, 0, 100)).toEqual({ startS: 10, endS: null });
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: 10.3 }, 0, 100)).toEqual({ startS: 10, endS: null });
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: 4 }, 0, 100)).toEqual({ startS: 10, endS: null });
  });

  it('falls back when the moment is at or past the end of the media', () => {
    expect(planReplay([], { suggestedMediaS: 120, endMediaS: 130 }, 0, 100)).toEqual({ startS: 100, endS: null });
  });

  it('treats NaN and infinite inputs as unusable instead of throwing', () => {
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: Number.NaN }, 0, 100)).toEqual({ startS: 10, endS: null });
    expect(planReplay([], { suggestedMediaS: 10, endMediaS: Infinity }, 0, null)).toEqual({ startS: 10, endS: null });
  });
});
