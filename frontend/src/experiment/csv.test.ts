import { describe, expect, it } from 'vitest';
import { parseEegCsv, replayScore } from './csv';

describe('experimental EEG CSV import', () => {
  it('reads quoted BOM/CRLF score files and maps epoch timestamps to lecture zero', () => {
    const replay = parseEegCsv('\uFEFF"timestamp","attention_score"\r\n1700000000,80\r\n1700000001,\r\n1700000002,20\r\n');
    expect(replay.method).toBe('scores');
    expect(replay.points).toEqual([{ timeS: 0, score: 80 }, { timeS: 1, score: null }, { timeS: 2, score: 20 }]);
    expect(replayScore(replay, -.1)).toBeNull();
    expect(replayScore(replay, .5)).toBe(80);
    expect(replayScore(replay, 1.5)).toBeNull();
    expect(replayScore(replay, 3)).toBeNull();
  });

  it('supports explicit milliseconds and one-second score rows without timestamps', () => {
    expect(parseEegCsv('time_ms,score\n100,80\n1100,20').points[1]!.timeS).toBe(1);
    expect(parseEegCsv('attention_score\n80\n20').durationS).toBe(2);
  });

  it('does not hold a score over a sparse recording gap', () => {
    const replay = parseEegCsv('time_s,score\n0,80\n1,70\n2,50\n20,10');
    expect(replayScore(replay, 10)).toBeNull();
    expect(replayScore(replay, 20)).toBe(10);
  });

  it.each([
    ['time_s,score\n0,200', '0–100'],
    ['time_s,score\n0,50\n0,30', 'strictly increasing'],
    ['time_s,score\n0,50\n-1,30', 'strictly increasing'],
    ['time_s,score\n,50', 'strictly increasing'],
    ['time_s,score\n0,', 'No usable'],
    ['time_s,score\n0,50,extra', 'same number'],
    ['score,score\n20,20', 'unique'],
    ['"score\n20', 'unclosed'],
    ['timestamp,sample_index\n0,1', 'EEG channel'],
    ['score\n', 'header and data'],
  ])('rejects invalid input %s', (text, message) => {
    expect(() => parseEegCsv(text)).toThrow(message);
  });

  const raw = (frequency: number, blank = false, timestamps = true) => {
    const rows = Array.from({ length: 1000 }, (_, i) => `${timestamps ? `${100 + i / 250},${i},` : ''}${blank && i < 500 ? '' : Math.sin(2 * Math.PI * frequency * i / 250) * 10}`);
    return `${timestamps ? 'timestamp,sample_index,Fz' : 'Fz'}\n${rows.join('\n')}`;
  };

  it('extracts beta/theta spectral test scores from raw channels, ignoring sample_index', () => {
    const beta = parseEegCsv(raw(20));
    const theta = parseEegCsv(raw(6));
    expect(beta.method).toBe('spectral');
    expect(beta.durationS).toBeCloseTo(4);
    expect(beta.points[0]!.score).toBeGreaterThan(99);
    expect(theta.points[0]!.score).toBeLessThan(1);
    expect(parseEegCsv(raw(20, false, false)).points[0]!.score).toBeGreaterThan(99);
  });

  it('keeps missing raw windows as gaps and rejects flat or short recordings', () => {
    const replay = parseEegCsv(raw(20, true));
    expect(replay.points[0]!.score).toBeNull();
    expect(replay.points[1]!.score).toBeGreaterThan(99);
    expect(() => parseEegCsv('Fz\n' + Array(500).fill('0').join('\n'))).toThrow('non-flat');
    expect(() => parseEegCsv('Fz\n1\n2\n3')).toThrow('two seconds');
    expect(() => parseEegCsv('Fz\n1\n2', 20)).toThrow('sample rate');
  });
});
