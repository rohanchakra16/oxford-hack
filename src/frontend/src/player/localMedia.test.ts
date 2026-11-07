import { describe, expect, it } from 'vitest';
import { checkVideoFile, describeMediaError, formatMediaTime, localVideoId, type FileLike } from './localMedia';

const file = (over: Partial<FileLike> = {}): FileLike => ({
  name: 'lecture-01.mp4',
  size: 123_456_789,
  type: 'video/mp4',
  lastModified: 1_700_000_000_000,
  ...over,
});

// Same pattern as the shared contract's videoId (contracts/schema/oxford-hack.schema.json).
const VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

describe('checkVideoFile', () => {
  it('accepts video MIME types and known extensions', () => {
    expect(checkVideoFile(file()).ok).toBe(true);
    expect(checkVideoFile(file({ name: 'talk.MKV', type: '' })).ok).toBe(true);
  });

  it('rejects empty and non-video files with a reason', () => {
    const empty = checkVideoFile(file({ size: 0 }));
    expect(empty.ok).toBe(false);
    const pdf = checkVideoFile(file({ name: 'notes.pdf', type: 'application/pdf' }));
    expect(pdf).toMatchObject({ ok: false });
    if (!pdf.ok) expect(pdf.reason).toContain('notes.pdf');
  });
});

describe('localVideoId', () => {
  it('is stable and matches the contract pattern', async () => {
    const a = await localVideoId(file());
    expect(a).toMatch(/^local-[0-9a-f]{16}$/);
    expect(a).toMatch(VIDEO_ID);
    expect(await localVideoId(file())).toBe(a);
  });

  it('differs when name, size or lastModified differ', async () => {
    const base = await localVideoId(file());
    expect(await localVideoId(file({ name: 'lecture-02.mp4' }))).not.toBe(base);
    expect(await localVideoId(file({ size: 1 }))).not.toBe(base);
    expect(await localVideoId(file({ lastModified: 1 }))).not.toBe(base);
  });

  it('handles names the contract would reject', async () => {
    expect(await localVideoId(file({ name: 'Lecture 3 (week 2) — ünïcode.mp4' }))).toMatch(VIDEO_ID);
  });
});

describe('formatMediaTime', () => {
  it('formats mm:ss and h:mm:ss, and unknown values', () => {
    expect(formatMediaTime(0)).toBe('0:00');
    expect(formatMediaTime(65.9)).toBe('1:05');
    expect(formatMediaTime(3725)).toBe('1:02:05');
    expect(formatMediaTime(null)).toBe('--:--');
    expect(formatMediaTime(NaN)).toBe('--:--');
  });
});

describe('describeMediaError', () => {
  it('explains unsupported formats', () => {
    expect(describeMediaError(4)).toMatch(/cannot play this video format/);
    expect(describeMediaError(undefined)).toMatch(/could not be played/);
  });
});
