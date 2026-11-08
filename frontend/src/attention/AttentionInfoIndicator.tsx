/**
 * YouTube-style contextual ⓘ indicator for the video stage (#55).
 * Mount it in LecturePlayer's `overlay` slot so it stays anchored to the video in normal,
 * maximised and true fullscreen modes. Never pauses playback; bursts are coalesced into one icon.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatMediaTime } from '../player';
import type { AttentionTimelineStore } from './store';
import type { AttentionMarker } from './types';
import './attention.css';

export interface AttentionInfoIndicatorProps {
  store: AttentionTimelineStore;
  onSeek?: (timeS: number, marker: AttentionMarker) => void;
  /** How long the icon stays fully visible after an event (ms). */
  visibleMs?: number;
  /** Which marker kinds raise the indicator. */
  kinds?: readonly AttentionMarker['kind'][];
}

const MAX_EVENTS = 5;

/** Pure queue logic (exported for tests): newest first, deduplicated by id, bounded. */
export function pushEvent(events: readonly AttentionMarker[], marker: AttentionMarker, max = MAX_EVENTS): AttentionMarker[] {
  return [marker, ...events.filter((e) => e.id !== marker.id)].slice(0, max);
}

export function AttentionInfoIndicator({ store, onSeek, visibleMs = 6000, kinds = ['review', 'bookmark'] }: AttentionInfoIndicatorProps) {
  const [events, setEvents] = useState<AttentionMarker[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kindsKey = kinds.join(',');

  useEffect(() => {
    const allowed = new Set(kindsKey.split(','));
    return store.onMarkerAdded((marker) => {
      if (!allowed.has(marker.kind)) return;
      setEvents((prev) => pushEvent(prev, marker));
      setUnseen((n) => n + 1);
      setVisible(true);
    });
  }, [store, kindsKey]);

  // Lecture change: drop events from the previous lecture.
  const videoId = useSyncExternalStore(store.subscribe, () => store.getSnapshot().videoId, () => null);
  useEffect(() => {
    setEvents([]);
    setUnseen(0);
    setVisible(false);
    setOpen(false);
  }, [videoId]);

  // Fade out after visibleMs unless the popover is open; each new event restarts the timer.
  useEffect(() => {
    if (!visible || open) return;
    hideRef.current = setTimeout(() => setVisible(false), visibleMs);
    return () => {
      if (hideRef.current) clearTimeout(hideRef.current);
    };
  }, [visible, open, visibleMs, unseen]);

  // Dismiss on Escape or outside click while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  if (events.length === 0) return null;
  const latest = events[0]!;
  const others = events.slice(1);
  const state = open ? 'open' : visible ? 'visible' : 'idle';

  return (
    <div className="att-info" data-state={state} ref={rootRef} data-testid="attention-info">
      <button
        ref={buttonRef}
        type="button"
        className="att-info__icon"
        aria-label={`${unseen > 1 ? `${unseen} new review events` : 'New review event'}: ${latest.label} at ${formatMediaTime(latest.startS)}. Show details.`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation(); // never toggles playback on the video underneath
          setOpen((o) => !o);
          setUnseen(0);
        }}
      >
        <span aria-hidden="true">i</span>
        {unseen > 1 && !open && <span className="att-info__count" aria-hidden="true">{unseen}</span>}
      </button>

      {open && (
        <div className="att-info__pop" role="dialog" aria-label="Review event details" onClick={(e) => e.stopPropagation()}>
          <EventDetail marker={latest} onSeek={(m) => { onSeek?.(m.startS, m); setOpen(false); }} />
          {others.length > 0 && (
            <ul className="att-info__more" aria-label="Earlier events">
              {others.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => { onSeek?.(m.startS, m); setOpen(false); }}>
                    <span className={`att-dot att-dot--${m.kind}`} aria-hidden="true" />
                    {m.label} · {formatMediaTime(m.startS)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function EventDetail({ marker, onSeek }: { marker: AttentionMarker; onSeek: (m: AttentionMarker) => void }) {
  return (
    <div className="att-info__detail">
      <p className="att-eyebrow">{marker.kind === 'review' ? 'Review point' : 'Bookmark'}{marker.origin === 'simulated' ? ' · simulated' : ''}</p>
      <strong>{marker.label}</strong>
      <dl>
        <div><dt>Time</dt><dd>{formatMediaTime(marker.startS)}{marker.endS !== null && marker.endS > marker.startS ? `–${formatMediaTime(marker.endS)}` : ''}</dd></div>
        {marker.score != null && <div><dt>Attention score</dt><dd>{Math.round(marker.score)}</dd></div>}
      </dl>
      {marker.reason && <p className="att-info__reason">{marker.reason}</p>}
      <button type="button" className="att-button att-button--primary" onClick={() => onSeek(marker)}>
        Go to {formatMediaTime(marker.startS)}
      </button>
    </div>
  );
}
