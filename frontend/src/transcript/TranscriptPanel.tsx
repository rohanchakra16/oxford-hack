/**
 * TranscriptPanel: open a caption file, show it as sentences, highlight the current one while the
 * lecture plays, and seek when a sentence is clicked.
 * Owner: Person 4 (@aryanmorarji). See src/transcript/README.md.
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatMediaTime, type PlayerHandle } from '../player';
import { durationMismatch, loadTranscriptFile, type Transcript } from './load';
import { sentenceIndexAt, type Sentence } from './sentences';
import './transcript.css';

export interface TranscriptPanelProps {
  /** Player to follow and seek. Null while the player is mounting. */
  player: PlayerHandle | null;
  /** Called when a transcript is loaded or cleared (e.g. so the review UI can pick sentence starts). */
  onTranscriptChange?: (transcript: Transcript | null) => void;
}

type PanelState = { kind: 'empty' } | { kind: 'loading'; fileName: string } | { kind: 'error'; message: string };

const NOOP_SUBSCRIBE = () => () => {};

export function TranscriptPanel({ player, onTranscriptChange }: TranscriptPanelProps) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [state, setState] = useState<PanelState>({ kind: 'empty' });
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLOListElement | null>(null);
  const onChangeRef = useRef(onTranscriptChange);
  onChangeRef.current = onTranscriptChange;

  // Re-render only when the current sentence changes, not on every timeupdate.
  const sentences = transcript?.sentences;
  const current = useSyncExternalStore(
    player?.subscribe ?? NOOP_SUBSCRIBE,
    () => (player && sentences ? sentenceIndexAt(sentences, player.getState().mediaTimeS) : -1),
    () => -1,
  );
  const durationS = useSyncExternalStore(
    player?.subscribe ?? NOOP_SUBSCRIBE,
    () => player?.getState().durationS ?? null,
    () => null,
  );

  useEffect(() => {
    if (!follow || current < 0) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-sentence="${current}"]`);
    if (list && el) scrollListTo(list, el);
  }, [current, follow]);

  async function open(file: File) {
    setState({ kind: 'loading', fileName: file.name });
    const result = await loadTranscriptFile(file);
    if (!result.ok) {
      setState({ kind: 'error', message: result.message });
      return; // keep any previous transcript visible
    }
    setTranscript(result.transcript);
    setState({ kind: 'empty' });
    onChangeRef.current?.(result.transcript);
  }

  function clear() {
    setTranscript(null);
    setState({ kind: 'empty' });
    onChangeRef.current?.(null);
  }

  const mismatch = transcript ? durationMismatch(transcript, durationS) : null;
  const canSeek = player !== null && durationS !== null;

  return (
    <section className="tp" aria-label="Transcript">
      <div className="tp-toolbar">
        <label className="tp-open">
          <span>Open transcript</span>
          <input
            type="file"
            accept=".vtt,.srt,text/vtt"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void open(file);
            }}
          />
        </label>
        {transcript && (
          <>
            <label className="tp-follow">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} /> Follow
              along
            </label>
            <button type="button" onClick={clear}>
              Close transcript
            </button>
          </>
        )}
      </div>

      {state.kind === 'loading' && <p role="status">Reading {state.fileName}…</p>}
      {state.kind === 'error' && (
        <p className="tp-error" role="alert">
          {state.message}
        </p>
      )}
      {!transcript && state.kind !== 'loading' && (
        <p className="tp-empty">
          No transcript open. Choose a WebVTT (.vtt) or SubRip (.srt) caption file for this lecture. It stays on this
          device.
        </p>
      )}

      {transcript && (
        <>
          <p className="tp-meta">
            {transcript.fileName} · {transcript.sentences.length} sentences
            {!canSeek && ' · open the lecture video to jump to a sentence'}
          </p>
          {mismatch && (
            <p className="tp-warning" role="status">
              {mismatch}
            </p>
          )}
          {transcript.warnings.length > 0 && (
            <details className="tp-warning">
              <summary>
                {transcript.warnings.length} problem{transcript.warnings.length === 1 ? '' : 's'} in the file (skipped)
              </summary>
              <ul>
                {transcript.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <ol className="tp-list" ref={listRef}>
            {transcript.sentences.map((s) => (
              <SentenceRow
                key={s.index}
                sentence={s}
                current={s.index === current}
                disabled={!canSeek}
                onSeek={(t) => player?.seek(t)}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

const SentenceRow = memo(function SentenceRow({
  sentence,
  current,
  disabled,
  onSeek,
}: {
  sentence: Sentence;
  current: boolean;
  disabled: boolean;
  onSeek: (timeS: number) => void;
}) {
  return (
    <li data-sentence={sentence.index} className={current ? 'tp-current' : undefined}>
      <button
        type="button"
        className="tp-sentence"
        disabled={disabled}
        aria-current={current ? 'true' : undefined}
        onClick={() => onSeek(sentence.startS)}
      >
        <span className="tp-time">{formatMediaTime(sentence.startS)}</span>
        <span>{sentence.text}</span>
      </button>
    </li>
  );
},
(a, b) => a.sentence === b.sentence && a.current === b.current && a.disabled === b.disabled);

/**
 * Scroll only the transcript list so `el` is visible ("nearest"). Unlike `scrollIntoView`, this never
 * scrolls the page or any other ancestor, so following along can't pull the viewer away from the video.
 */
function scrollListTo(list: HTMLElement, el: HTMLElement) {
  const listBox = list.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  let delta = 0;
  if (box.top < listBox.top) delta = box.top - listBox.top;
  else if (box.bottom > listBox.bottom) delta = Math.min(box.bottom - listBox.bottom, box.top - listBox.top);
  if (delta !== 0) list.scrollTo({ top: list.scrollTop + delta, behavior: 'smooth' });
}
