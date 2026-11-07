/**
 * Transcript parsing: WebVTT (.vtt) and SubRip (.srt) caption files -> timed cues.
 * Owner: Person 4 (@aryanmorarji). See src/transcript/README.md.
 *
 * Units: media seconds (same clock as HTMLMediaElement.currentTime).
 * Tolerant of real-world files: BOM, CRLF, cue settings, NOTE/STYLE/REGION blocks, voice and
 * styling tags, inline timestamps, and the rolling duplicate lines in auto-generated captions.
 * Malformed individual cues are skipped and reported as warnings; a file with no usable cues
 * is an error.
 */

export interface Cue {
  /** Position in the cleaned, sorted list (0-based). */
  index: number;
  startS: number;
  endS: number;
  /** Plain text: tags stripped, entities decoded, whitespace collapsed, one line. */
  text: string;
}

export type TranscriptFormat = 'vtt' | 'srt';

export interface ParsedTranscript {
  format: TranscriptFormat;
  cues: Cue[];
  /** Non-fatal problems (skipped cues, reordering), safe to show to users. */
  warnings: string[];
}

export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptParseError';
  }
}

const TIMING = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/;
const MAX_WARNINGS = 20;

/** "01:02:03.456", "02:03.456", "00:00:01,000" (SRT) -> seconds, or null if malformed. */
export function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const ms = Number(m[4]!.padEnd(3, '0'));
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' };

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, '') // <v Speaker>, <c.x>, <i>, <00:00:01.000>
    .replace(/\{\\[^}]*\}/g, '') // SRT/ASS style overrides like {\an8}
    .replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function detectFormat(text: string, fileName: string | undefined): TranscriptFormat {
  if (/^WEBVTT(?:[ \t].*)?$/m.test(text.split('\n', 1)[0] ?? '')) return 'vtt';
  const ext = fileName?.split('.').pop()?.toLowerCase();
  if (ext === 'vtt') return 'vtt';
  return 'srt';
}

/**
 * Parse caption text. `fileName` is only used to pick the format and for messages.
 * Throws TranscriptParseError if nothing usable is found.
 */
export function parseTranscript(input: string, fileName?: string): ParsedTranscript {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const label = fileName ? `"${fileName}"` : 'The transcript';
  if (text.trim() === '') throw new TranscriptParseError(`${label} is empty.`);

  const format = detectFormat(text, fileName);
  if (format === 'vtt' && !text.startsWith('WEBVTT')) {
    throw new TranscriptParseError(`${label} is not a valid WebVTT file: it must start with "WEBVTT".`);
  }

  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
    else if (warnings.length === MAX_WARNINGS) warnings.push('More problems were found and not listed.');
  };

  const blocks = text.split(/\n[ \t]*\n+/);
  const raw: { startS: number; endS: number; lines: string[] }[] = [];
  let lineNo = 1;
  for (const [bi, block] of blocks.entries()) {
    const blockLine = lineNo;
    lineNo += block.split('\n').length + 1;
    const lines = block.split('\n').filter((l, i, all) => !(i === all.length - 1 && l.trim() === ''));
    if (lines.length === 0) continue;
    if (format === 'vtt' && bi === 0) continue; // WEBVTT header block
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0]!)) continue;

    const timingAt = lines.findIndex((l) => l.includes('-->'));
    if (timingAt === -1 || timingAt > 1) {
      if (lines.some((l) => l.trim() !== '')) warn(`Skipped text without a timestamp near line ${blockLine}.`);
      continue;
    }
    const m = TIMING.exec(lines[timingAt]!);
    const startS = m ? parseTimestamp(m[1]!) : null;
    const endS = m ? parseTimestamp(m[2]!) : null;
    if (startS === null || endS === null) {
      warn(`Skipped a cue with an unreadable timestamp near line ${blockLine + timingAt}.`);
      continue;
    }
    if (!(endS > startS)) {
      warn(`Skipped a cue that ends before it starts near line ${blockLine + timingAt}.`);
      continue;
    }
    const body = lines.slice(timingAt + 1).map(cleanLine).filter((l) => l !== '');
    if (body.length === 0) continue; // empty cues are common and harmless
    raw.push({ startS, endS, lines: body });
  }

  // Sort by start (stable), noting if the file was out of order.
  if (raw.some((c, i) => i > 0 && c.startS < raw[i - 1]!.startS)) {
    warn('Cues were out of order and have been sorted by start time.');
    raw.sort((a, b) => a.startS - b.startS);
  }

  // Auto-generated captions repeat the previous cue's last line(s) at the top of the next cue.
  const cues: Cue[] = [];
  let prevLines: string[] = [];
  for (const c of raw) {
    let lines = c.lines;
    while (lines.length > 0 && prevLines.includes(lines[0]!)) lines = lines.slice(1);
    prevLines = c.lines;
    const joined = lines.join(' ').trim();
    if (joined === '') continue;
    cues.push({ index: cues.length, startS: c.startS, endS: c.endS, text: joined });
  }

  if (cues.length === 0) {
    throw new TranscriptParseError(
      `${label} has no readable captions. Expected a WebVTT (.vtt) or SubRip (.srt) file with timestamps like 00:01:02.500 --> 00:01:05.000.`,
    );
  }
  return { format, cues, warnings };
}
