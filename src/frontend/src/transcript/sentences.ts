/**
 * Sentences: the transcript's navigation and replay unit, built from caption cues.
 * Owner: Person 4 (@aryanmorarji). See src/transcript/README.md.
 *
 * Caption cues break wherever the captioner chose, often mid-sentence. Replay should start at
 * the beginning of a sentence ("docs/frontend-integration.md" §4.3: the transcript-adjusted
 * replay destination is P4's), so cues are merged and re-split at sentence punctuation.
 *
 * Timing inside a cue is not known word by word, so a boundary inside a cue is placed by
 * character position (linear interpolation). Accuracy is therefore about one cue (a few seconds)
 * at worst. Captions without punctuation fall back to pauses between cues and a maximum length.
 */
import type { TranscriptContext } from '../integration';
import type { Cue } from './parse';

export interface Sentence {
  index: number;
  /** Media seconds. */
  startS: number;
  endS: number;
  text: string;
  /** Indices of the cues this sentence draws from. */
  cueIndices: number[];
}

export interface SentenceOptions {
  /** A silence of at least this long between cues ends a sentence. */
  gapS: number;
  /** Without punctuation, end a sentence at the next cue boundary after this long. */
  maxSentenceS: number;
}

export const DEFAULT_SENTENCE_OPTIONS: SentenceOptions = { gapS: 2, maxSentenceS: 20 };

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'approx', 'fig', 'eq', 'no', 'dr', 'mr', 'mrs', 'ms', 'prof', 'st',
]);

/** Character offsets just after each sentence end inside `text` (punctuation plus closing quotes). */
function boundaries(text: string): number[] {
  const out: number[] = [];
  const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index);
    const word = (/([A-Za-z.]+)$/.exec(before)?.[1] ?? '').toLowerCase().replace(/\.$/, '');
    if (m[0].startsWith('.') && m[0].length === 1) {
      if (ABBREVIATIONS.has(word)) continue;
    }
    out.push(m.index + m[0].length);
  }
  return out;
}

function leadingSpace(text: string, from: number): number {
  const rest = text.slice(from);
  return rest.length - rest.trimStart().length;
}

export function buildSentences(cues: readonly Cue[], options: Partial<SentenceOptions> = {}): Sentence[] {
  const opts = { ...DEFAULT_SENTENCE_OPTIONS, ...options };
  const sentences: Sentence[] = [];
  let parts: string[] = [];
  let cueIdx: number[] = [];
  let startS: number | null = null;

  const flush = (endS: number) => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text && startS !== null) {
      sentences.push({ index: sentences.length, startS, endS: Math.max(endS, startS), text, cueIndices: cueIdx });
    }
    parts = [];
    cueIdx = [];
    startS = null;
  };

  let prevEnd: number | null = null;
  for (const cue of cues) {
    if (prevEnd !== null && startS !== null) {
      const gap = cue.startS - prevEnd;
      const long = prevEnd - startS >= opts.maxSentenceS;
      if (gap >= opts.gapS || long) flush(prevEnd);
    }
    const dur = cue.endS - cue.startS;
    const len = cue.text.length;
    const timeAt = (offset: number) => cue.startS + (len > 0 ? (dur * offset) / len : 0);

    let from = 0;
    for (const b of boundaries(cue.text)) {
      const piece = cue.text.slice(from, b).trim();
      if (piece) {
        if (startS === null) startS = timeAt(from + leadingSpace(cue.text, from));
        parts.push(piece);
        if (!cueIdx.includes(cue.index)) cueIdx.push(cue.index);
      }
      if (startS !== null) flush(timeAt(b));
      from = b;
    }
    const rest = cue.text.slice(from).trim();
    if (rest) {
      if (startS === null) startS = timeAt(from + leadingSpace(cue.text, from));
      parts.push(rest);
      if (!cueIdx.includes(cue.index)) cueIdx.push(cue.index);
    }
    prevEnd = cue.endS;
  }
  if (prevEnd !== null) flush(prevEnd);
  return sentences;
}

/**
 * Index of the sentence playing at `timeS`: the last sentence that has started (so the previous
 * sentence stays current during a pause in speech). -1 before the first sentence. Binary search.
 */
export function sentenceIndexAt(sentences: readonly Sentence[], timeS: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.startS <= timeS + 1e-6) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Replay destination for a moment `timeS` (e.g. ReviewBookmark.suggestedMediaS): the start of the
 * sentence containing it, moved `sentencesEarlier` whole sentences back ("move earlier").
 * Before the first sentence, or with no transcript, returns `timeS` unchanged (clamped at 0).
 * PROPOSED rule: agree with @Betty505 (#1).
 */
export function replayStartFor(sentences: readonly Sentence[], timeS: number, sentencesEarlier = 0): number {
  const i = sentenceIndexAt(sentences, timeS);
  if (i < 0) return Math.max(0, timeS);
  const target = Math.max(0, i - Math.max(0, Math.floor(sentencesEarlier)));
  return sentences[target]!.startS;
}

/** The shared contract's TranscriptContext for a sentence. */
export function toTranscriptContext(sentence: Sentence): TranscriptContext {
  return { startMediaS: sentence.startS, endMediaS: sentence.endS, text: sentence.text };
}
