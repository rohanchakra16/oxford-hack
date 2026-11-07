/**
 * Load a transcript file from this device and check it against the loaded video.
 * Owner: Person 4 (@aryanmorarji). The file is read in the browser and never uploaded.
 */
import { parseTranscript, TranscriptParseError, type Cue, type TranscriptFormat } from './parse';
import { buildSentences, type Sentence } from './sentences';

export interface Transcript {
  fileName: string;
  format: TranscriptFormat;
  cues: Cue[];
  sentences: Sentence[];
  warnings: string[];
}

export type TranscriptLoad = { ok: true; transcript: Transcript } | { ok: false; message: string };

/** Caption files are small; anything above this is almost certainly the wrong file. */
export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export interface TextFileLike {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

export function transcriptFromText(text: string, fileName: string): TranscriptLoad {
  try {
    const parsed = parseTranscript(text, fileName);
    return { ok: true, transcript: { fileName, ...parsed, sentences: buildSentences(parsed.cues) } };
  } catch (e) {
    if (e instanceof TranscriptParseError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function loadTranscriptFile(file: TextFileLike): Promise<TranscriptLoad> {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!['vtt', 'srt', 'txt'].includes(ext)) {
    return { ok: false, message: `"${file.name}" is not a caption file. Choose a WebVTT (.vtt) or SubRip (.srt) file.` };
  }
  if (file.size === 0) return { ok: false, message: `"${file.name}" is empty.` };
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, message: `"${file.name}" is too large for a caption file. Is it the right file?` };
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: `"${file.name}" could not be read.` };
  }
  return transcriptFromText(text, file.name);
}

/**
 * Warning if the transcript clearly does not belong to the video: it runs well past the end.
 * Null if it looks consistent or the duration is unknown.
 */
export function durationMismatch(transcript: Transcript, durationS: number | null, toleranceS = 5): string | null {
  if (durationS === null || transcript.cues.length === 0) return null;
  const last = transcript.cues[transcript.cues.length - 1]!.endS;
  if (last > durationS + toleranceS) {
    return `The transcript runs to ${Math.round(last)} s but the video is ${Math.round(durationS)} s long. It may be for a different lecture.`;
  }
  return null;
}
