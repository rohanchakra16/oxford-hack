/** End-of-lecture attention summary (#55): full graph + statistics, same store as the live graph. */
import { useMemo } from 'react';
import { formatMediaTime } from '../player';
import { AttentionGraph, type SeekTarget } from './AttentionGraph';
import { useTimeline } from './hooks';
import { lowRegions, timelineStats, type AttentionTimelineStore } from './store';
import type { PlaybackSource } from './types';

export interface AttentionSummaryProps {
  store: AttentionTimelineStore;
  playback?: PlaybackSource | null;
  onSeek?: (timeS: number, target: SeekTarget) => void;
  onClose?: () => void;
}

export function AttentionSummary({ store, playback, onSeek, onClose }: AttentionSummaryProps) {
  const snapshot = useTimeline(store);
  const measured = useMemo(() => timelineStats(snapshot, 'measured'), [snapshot]);
  const simulated = useMemo(() => timelineStats(snapshot, 'simulated'), [snapshot]);
  const regions = useMemo(() => lowRegions(snapshot).sort((a, b) => (a.minScore ?? 101) - (b.minScore ?? 101)).slice(0, 3), [snapshot]);
  // Real measurements take priority; simulated statistics are shown only when nothing real exists, and labelled.
  const usingSimulated = measured.measuredSeconds === 0 && simulated.measuredSeconds > 0;
  const s = usingSimulated ? simulated : measured;
  const unavailable = snapshot.availability.state === 'unavailable' ? snapshot.availability.message : null;
  const reviewCount = snapshot.markers.filter((m) => m.kind === 'review').length;
  const bookmarkCount = snapshot.markers.filter((m) => m.kind === 'bookmark').length;

  return (
    <section className="att-summary" aria-labelledby="att-summary-title" data-testid="attention-summary">
      <header className="att-summary__head">
        <div>
          <p className="att-eyebrow">{snapshot.completed ? 'Lecture complete' : 'So far'}</p>
          <h2 id="att-summary-title">Attention summary</h2>
        </div>
        {onClose && <button type="button" className="att-button att-button--quiet" onClick={onClose}>Back to lecture</button>}
      </header>

      {usingSimulated && <p className="att-summary__notice" role="note">These statistics come from Demo mode. They are simulated, not real measurements.</p>}
      {!usingSimulated && simulated.measuredSeconds > 0 && <p className="att-summary__notice" role="note">Demo mode data is shown on the graph but excluded from these statistics.</p>}

      <dl className="att-stats">
        <Stat label="Average attention" value={s.average === null ? '—' : `${Math.round(s.average)}`} hint={s.average === null ? unavailable ?? 'No scores recorded' : `${formatMediaTime(s.measuredSeconds)} ${usingSimulated ? "simulated" : "measured"}`} />
        <Stat label="Lowest point" value={s.lowest ? `${Math.round(s.lowest.score)}` : '—'} hint={s.lowest ? `at ${formatMediaTime(s.lowest.t)}` : 'Not available'} onClick={s.lowest ? () => onSeek?.(s.lowest!.t, { kind: 'time' }) : undefined} />
        <Stat label="Low-attention time" value={formatMediaTime(s.lowSeconds)} hint={`${s.lowRegions} ${s.lowRegions === 1 ? 'period' : 'periods'}`} />
        <Stat label="Review points" value={`${reviewCount}`} hint="Generated automatically" />
        <Stat label="Bookmarks" value={`${bookmarkCount}`} hint="Added by you" />
      </dl>

      <AttentionGraph store={store} playback={playback} onSeek={onSeek} variant="full" refreshMs={0} />

      {regions.length > 0 && (
        <div className="att-summary__lows">
          <h3>Lowest-attention periods</h3>
          <ul>
            {regions.map((r) => (
              <li key={r.id}>
                <button type="button" className="att-chip att-chip--low" onClick={() => onSeek?.(r.startS, { kind: 'low', region: r })}>
                  {formatMediaTime(r.startS)}–{formatMediaTime(r.endS)}
                  {r.minScore !== null && <span> · min {Math.round(r.minScore)}</span>}
                  {r.origin === 'simulated' && <span> · simulated</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshot.markers.length > 0 && (
        <div className="att-summary__lows">
          <h3>Review points and bookmarks</h3>
          <ul>
            {snapshot.markers.map((m) => (
              <li key={m.id}>
                <button type="button" className={`att-chip att-chip--${m.kind}`} onClick={() => onSeek?.(m.startS, { kind: 'marker', marker: m })}>
                  {formatMediaTime(m.startS)} · {m.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint, onClick }: { label: string; value: string; hint: string; onClick?: () => void }) {
  return (
    <div className="att-stat">
      <dt>{label}</dt>
      <dd>
        {onClick ? <button type="button" className="att-stat__value att-stat__value--link" onClick={onClick} title="Go to this moment">{value}</button> : <span className="att-stat__value">{value}</span>}
        <span className="att-stat__hint">{hint}</span>
      </dd>
    </div>
  );
}
