/**
 * Attention-over-time graph (#55). Compact (sidebar, refreshes every 2 min) and full (summary) variants
 * share the same store and rendering. X = lecture media time, Y = 0..100 attention estimate.
 * Owner: Person 4 (@aryanmorarji).
 */
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { formatMediaTime } from '../player';
import { useRefreshedTimeline } from './hooks';
import { latestSeries, lowRegions, type AttentionTimelineStore } from './store';
import type { AttentionMarker, AttentionPoint, AttentionSegment, LowRegion, PlaybackSource, TimelineSnapshot } from './types';
import './attention.css';

export type SeekTarget =
  | { kind: 'marker'; marker: AttentionMarker }
  | { kind: 'low'; region: LowRegion }
  | { kind: 'time' };

export interface AttentionGraphProps {
  store: AttentionTimelineStore;
  /** Usually the PlayerHandle; drives the playhead. */
  playback?: PlaybackSource | null;
  onSeek?: (timeS: number, target: SeekTarget) => void;
  variant?: 'compact' | 'full';
  /** Line refresh period. Default: 2 minutes for compact, live for full. */
  refreshMs?: number;
  title?: string;
}

const PAD = { left: 30, right: 10, top: 18, bottom: 22 };
const MARKER_LANE_PX = 13;
const MARKER_MAX_LANES = 3;

/**
 * Assigns each marker a vertical lane so heads closer than one head-width are stacked instead of
 * drawn on top of each other. Pure; exported for tests.
 */
export function markerLanes(markers: readonly { id: string; startS: number }[], sx: (t: number) => number, minGapPx = 14): Map<string, number> {
  const out = new Map<string, number>();
  const lastX: number[] = [];
  for (const m of [...markers].sort((a, b) => a.startS - b.startS)) {
    const x = sx(m.startS);
    let lane = lastX.findIndex((lx) => x - lx >= minGapPx);
    if (lane === -1) lane = lastX.length < MARKER_MAX_LANES ? lastX.length : lastX.indexOf(Math.min(...lastX));
    lastX[lane] = x;
    out.set(m.id, lane);
  }
  return out;
}
const NOOP_SUBSCRIBE = () => () => {};

type Hover =
  | { kind: 'time'; t: number; point: AttentionPoint | null; x: number; y: number }
  | { kind: 'marker'; marker: AttentionMarker; x: number; y: number }
  | { kind: 'low'; region: LowRegion; x: number; y: number };

export function AttentionGraph({ store, playback, onSeek, variant = 'compact', refreshMs, title }: AttentionGraphProps) {
  const period = refreshMs ?? (variant === 'compact' ? 120_000 : 0);
  const { snapshot, refreshedAt, refreshNow } = useRefreshedTimeline(store, period);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrapRef, variant === 'compact' ? 320 : 720);
  const height = variant === 'compact' ? 150 : 260;
  const [hover, setHover] = useState<Hover | null>(null);

  const measured = useMemo(() => latestSeries(snapshot, 'measured'), [snapshot.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const simulated = useMemo(() => latestSeries(snapshot, 'simulated'), [snapshot.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const regions = useMemo(() => lowRegions(snapshot), [snapshot.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const playerDuration = useSyncExternalStore(playback?.subscribe ?? NOOP_SUBSCRIBE, () => playback?.getState().durationS ?? null, () => null);
  const domainS = useMemo(() => domainFor(snapshot, playerDuration), [snapshot, playerDuration]);

  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const sx = useMemo(() => (t: number) => PAD.left + (Math.min(Math.max(t, 0), domainS) / domainS) * plotW, [domainS, plotW]);
  const sy = useMemo(() => (score: number) => PAD.top + (1 - score / 100) * plotH, [plotH]);
  const tAt = (x: number) => Math.min(domainS, Math.max(0, ((x - PAD.left) / plotW) * domainS));
  const superseded = useMemo(() => supersededKeys(snapshot.segments), [snapshot.segments]);
  const lanes = useMemo(() => markerLanes(snapshot.markers, sx), [snapshot.markers, sx]);

  const hasPoints = measured.length > 0 || simulated.length > 0;
  const anyScore = measured.some((p) => p.score !== null) || simulated.some((p) => p.score !== null);
  const hasSimulated = simulated.length > 0 || snapshot.markers.some((m) => m.origin === 'simulated');

  const onPlotMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = tAt(x);
    const series = measured.length ? measured : simulated;
    const point = nearest(series, t, Math.max(2, domainS / plotW * 6));
    setHover({ kind: 'time', t: point?.t ?? t, point, x, y: point?.score != null ? sy(point.score) : PAD.top + plotH / 2 });
  };

  const seek = (t: number, target: SeekTarget) => onSeek?.(Math.max(0, t), target);
  const keySeek = (t: number, target: SeekTarget) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      seek(t, target);
    }
  };

  const yTicks = [0, 50, 100];
  const xTicks = ticksFor(domainS, variant === 'compact' ? 3 : 6);
  const label = title ?? (variant === 'compact' ? 'Attention' : 'Attention over the lecture');
  const unavailable = snapshot.availability.state === 'unavailable' ? snapshot.availability.message : null;

  return (
    <div className={`att-graph att-graph--${variant}`} ref={wrapRef} data-testid={`attention-graph-${variant}`}>
      <div className="att-graph__head">
        <div>
          <p className="att-eyebrow">{variant === 'compact' ? 'Live timeline' : 'Full timeline'}</p>
          <h3 className="att-graph__title">{label}</h3>
        </div>
        {hasSimulated && <span className="att-badge att-badge--simulated" title="Demo mode data is simulated, not a real measurement">Simulated</span>}
        {variant === 'compact' && period > 0 && (
          <RefreshNote refreshedAt={refreshedAt} periodMs={period} onRefresh={refreshNow} />
        )}
      </div>

      <div className="att-graph__plot">
        <svg
          className="att-graph__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`${label}: ${measured.length} measured seconds, ${regions.length} low-attention periods, ${snapshot.markers.length} markers`}
          onPointerLeave={() => setHover(null)}
        >
          {/* grid */}
          {yTicks.map((v) => (
            <g key={v} className="att-grid">
              <line x1={PAD.left} x2={PAD.left + plotW} y1={sy(v)} y2={sy(v)} />
              <text x={PAD.left - 6} y={sy(v) + 3} textAnchor="end">{v}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="att-axis" x={sx(t)} y={height - 6} textAnchor="middle">{formatMediaTime(t)}</text>
          ))}

          {/* threshold */}
          {snapshot.threshold !== null && anyScore && (
            <g className="att-threshold">
              <line x1={PAD.left} x2={PAD.left + plotW} y1={sy(snapshot.threshold)} y2={sy(snapshot.threshold)} />
              <text x={PAD.left + plotW} y={sy(snapshot.threshold) - 3} textAnchor="end">low</text>
            </g>
          )}

          {/* hover target for the whole plot (below interactive marks) */}
          <rect
            className="att-hit"
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            onPointerMove={onPlotMove}
            onClick={(e) => {
              const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
              seek(tAt(e.clientX - rect.left), { kind: 'time' });
            }}
          />

          {/* low-attention periods */}
          {regions.map((r) => (
            <rect
              key={r.id}
              className={`att-low${r.origin === 'simulated' ? ' att-low--simulated' : ''}`}
              x={sx(r.startS)}
              y={PAD.top}
              width={Math.max(3, sx(r.endS) - sx(r.startS))}
              height={plotH}
              role="button"
              tabIndex={0}
              aria-label={`Low attention ${formatMediaTime(r.startS)} to ${formatMediaTime(r.endS)}${r.origin === 'simulated' ? ' (simulated)' : ''}. Go to start.`}
              onClick={() => seek(r.startS, { kind: 'low', region: r })}
              onKeyDown={keySeek(r.startS, { kind: 'low', region: r })}
              onPointerMove={(e) => {
                const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                setHover({ kind: 'low', region: r, x: e.clientX - rect.left, y: PAD.top + 8 });
              }}
            />
          ))}

          {/* attention lines: one per viewing; earlier viewings of the same span are faded */}
          {snapshot.segments.map((s) => (
            <SegmentPath key={s.key} segment={s} sx={sx} sy={sy} faded={superseded.has(s.key)} />
          ))}

          {/* markers */}
          {snapshot.markers.map((m) => {
            const x = sx(m.startS);
            const dy = (lanes.get(m.id) ?? 0) * MARKER_LANE_PX;
            const target: SeekTarget = { kind: 'marker', marker: m };
            const name = `${m.label} at ${formatMediaTime(m.startS)}. Go to moment.`;
            return (
              <g
                key={m.id}
                className={`att-marker att-marker--${m.kind}${m.origin === 'simulated' ? ' att-marker--simulated' : ''}`}
                transform={`translate(${x} ${PAD.top - 8})`}
                role="button"
                tabIndex={0}
                aria-label={name}
                onClick={() => seek(m.startS, target)}
                onKeyDown={keySeek(m.startS, target)}
                onPointerEnter={() => setHover({ kind: 'marker', marker: m, x, y: PAD.top + dy })}
                onFocus={() => setHover({ kind: 'marker', marker: m, x, y: PAD.top + dy })}
                onBlur={() => setHover(null)}
              >
                <line className="att-marker__stem" x1={0} x2={0} y1={6} y2={plotH + 8} />
                <g transform={`translate(0 ${dy})`}>
                  {/* only the head is a hit target, so markers at nearly the same time stay individually clickable */}
                  <rect className="att-marker__hit" x={-7} y={-7} width={14} height={14} />
                  {m.kind === 'bookmark' ? (
                    <path className="att-marker__head" d="M0 -5 L5 0 L0 5 L-5 0 Z" />
                  ) : (
                    <circle className="att-marker__head" r={5} />
                  )}
                </g>
              </g>
            );
          })}

          {/* playhead */}
          {playback && snapshot.videoId && <Playhead playback={playback} sx={sx} plotH={plotH} />}

          {hover?.kind === 'time' && (
            <g className="att-crosshair" aria-hidden="true">
              <line x1={sx(hover.t)} x2={sx(hover.t)} y1={PAD.top} y2={PAD.top + plotH} />
              {hover.point?.score != null && <circle cx={sx(hover.point.t)} cy={sy(hover.point.score)} r={3.5} />}
            </g>
          )}
        </svg>

        {!hasPoints && (
          <p className="att-graph__empty" role="status">
            {unavailable ?? (snapshot.videoId ? 'No attention scores yet. They appear here as you watch.' : 'Open a lecture to see its attention timeline.')}
          </p>
        )}
        {hasPoints && unavailable && <p className="att-graph__note" role="status">{unavailable}</p>}

        {hover && <Tooltip hover={hover} width={width} snapshot={snapshot} regions={regions} />}
      </div>

      <Legend hasSimulated={hasSimulated} />
    </div>
  );
}

/** Own subscription, so playback time updates re-render only this line. */
function Playhead({ playback, sx, plotH }: { playback: PlaybackSource; sx: (t: number) => number; plotH: number }) {
  const t = useSyncExternalStore(playback.subscribe ?? NOOP_SUBSCRIBE, () => playback.getState().mediaTimeS, () => 0);
  return (
    <g className="att-playhead" transform={`translate(${sx(t).toFixed(1)} 0)`} aria-hidden="true" data-testid="attention-playhead">
      <line x1={0} x2={0} y1={PAD.top - 4} y2={PAD.top + plotH} />
      <circle cy={PAD.top + plotH} r={3} />
    </g>
  );
}

const SegmentPath = memo(function SegmentPath({ segment, sx, sy, faded }: {
  segment: AttentionSegment;
  sx: (t: number) => number;
  sy: (s: number) => number;
  faded: boolean;
}) {
  // Rebuilt only when this segment, the scale or fading changes.
  const d = useMemo(() => pathFor(segment.points, sx, sy), [segment, sx, sy]);
  const lows = useMemo(
    () => segment.points.filter((p) => p.low && p.score !== null),
    [segment],
  );
  if (!d) return null;
  return (
    <g className={`att-line${segment.origin === 'simulated' ? ' att-line--simulated' : ''}${faded ? ' att-line--faded' : ''}`}>
      <path d={d} />
      {!faded && lows.map((p) => <circle key={p.t} className="att-line__low" cx={sx(p.t)} cy={sy(p.score!)} r={1.8} />)}
    </g>
  );
});

function Tooltip({ hover, width, snapshot, regions }: { hover: Hover; width: number; snapshot: TimelineSnapshot; regions: LowRegion[] }) {
  const left = Math.min(Math.max(hover.x, 70), width - 70);
  let body: React.ReactNode;
  if (hover.kind === 'marker') {
    const m = hover.marker;
    body = (
      <>
        <strong>{m.label}</strong>
        <span>{formatMediaTime(m.startS)}{m.endS !== null && m.endS > m.startS ? `–${formatMediaTime(m.endS)}` : ''}</span>
        {m.score != null && <span>Score {Math.round(m.score)}</span>}
        {m.reason && <span className="att-tip__reason">{m.reason}</span>}
        <span className="att-tip__hint">Click to go to this moment</span>
      </>
    );
  } else if (hover.kind === 'low') {
    const r = hover.region;
    body = (
      <>
        <strong>Low attention{r.origin === 'simulated' ? ' (simulated)' : ''}</strong>
        <span>{formatMediaTime(r.startS)}–{formatMediaTime(r.endS)}</span>
        {r.minScore !== null && <span>Lowest score {Math.round(r.minScore)}</span>}
        <span className="att-tip__hint">Click to go to the start</span>
      </>
    );
  } else {
    const near = snapshot.markers.filter((m) => Math.abs(m.startS - hover.t) <= 3);
    const inLow = regions.find((r) => hover.t >= r.startS && hover.t <= r.endS);
    body = (
      <>
        <strong>{formatMediaTime(hover.t)}</strong>
        <span>{hover.point ? (hover.point.score === null ? 'Score unavailable' : `Attention ${Math.round(hover.point.score)}`) : 'No measurement'}</span>
        {inLow && <span>Within a low-attention period</span>}
        {near.map((m) => <span key={m.id}>{m.label}</span>)}
      </>
    );
  }
  return (
    <div className="att-tip" style={{ left, top: Math.max(0, hover.y - 8) }} role="tooltip">
      {body}
    </div>
  );
}

function Legend({ hasSimulated }: { hasSimulated: boolean }) {
  return (
    <ul className="att-legend" aria-label="Graph legend">
      <li><span className="att-key att-key--line" />Attention</li>
      <li><span className="att-key att-key--low" />Low attention</li>
      <li><span className="att-key att-key--review" />Review point</li>
      <li><span className="att-key att-key--bookmark" />Bookmark</li>
      {hasSimulated && <li><span className="att-key att-key--simulated" />Simulated</li>}
    </ul>
  );
}

function RefreshNote({ refreshedAt, periodMs, onRefresh }: { refreshedAt: number | null; periodMs: number; onRefresh: () => void }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const next = refreshedAt === null ? null : Math.max(0, periodMs - (now - refreshedAt)) / 1000;
  return (
    <button type="button" className="att-refresh" onClick={onRefresh} title="Update the graph now">
      {next === null ? 'Waiting for data' : `Next update ${formatMediaTime(next)}`}
    </button>
  );
}

// ---------- geometry helpers ----------

function useWidth(ref: React.RefObject<HTMLDivElement | null>, fallback: number) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry!.contentRect.width);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function domainFor(s: TimelineSnapshot, playerDuration: number | null): number {
  const d = s.durationS ?? playerDuration;
  if (d && d > 0) return d;
  let max = 60;
  for (const seg of s.segments) {
    const last = seg.points[seg.points.length - 1];
    if (last) max = Math.max(max, last.t * 1.1);
  }
  for (const m of s.markers) max = Math.max(max, m.startS * 1.1);
  return max;
}

/** Path with breaks at gaps (null) and at jumps > 2.5 s; missing data is never drawn as zero. */
export function pathFor(points: readonly AttentionPoint[], sx: (t: number) => number, sy: (s: number) => number): string {
  let d = '';
  let prev: AttentionPoint | null = null;
  for (const p of points) {
    if (p.score === null) {
      prev = null;
      continue;
    }
    const cmd = prev && prev.score !== null && p.t - prev.t <= 2.5 ? 'L' : 'M';
    d += `${cmd}${sx(p.t).toFixed(1)} ${sy(p.score).toFixed(1)}`;
    prev = p;
  }
  return d;
}

function supersededKeys(segments: readonly AttentionSegment[]): Set<string> {
  const out = new Set<string>();
  const ranges = segments
    .filter((s) => s.points.length)
    .map((s) => ({ s, a: s.points[0]!.t, b: s.points[s.points.length - 1]!.t }));
  for (const r of ranges) {
    if (ranges.some((o) => o.s.origin === r.s.origin && o.s.seq > r.s.seq && o.a < r.b && o.b > r.a)) out.add(r.s.key);
  }
  return out;
}

function nearest(series: readonly AttentionPoint[], t: number, maxDist: number): AttentionPoint | null {
  let lo = 0;
  let hi = series.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  const cands = [series[lo - 1], series[lo]].filter(Boolean) as AttentionPoint[];
  const best = cands.reduce<AttentionPoint | null>((b, p) => (!b || Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), null);
  return best && Math.abs(best.t - t) <= maxDist ? best : null;
}

function ticksFor(domain: number, count: number): number[] {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => domain / s <= count) ?? 3600;
  const out: number[] = [];
  for (let t = 0; t <= domain + 0.001; t += step) out.push(t);
  return out;
}
