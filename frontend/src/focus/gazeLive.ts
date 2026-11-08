import { useEffect, useSyncExternalStore } from 'react';
import type { GazeSample } from '../../../evaluation/player/gaze-runtime';

export type { GazeSample };
export type GazeState = GazeSample['state'];
export type GazeBin = Record<GazeState, number>;

/** A sample older than this no longer describes where the person is looking now. */
const FRESH_MS = 1500;

export interface GazeRun { startS: number; endS: number; state: GazeState | 'none' }

/**
 * Local, in-memory webcam-gaze record for on-screen feedback. Independent of the EEG attention store: it holds
 * only what the camera pipeline reports (looking at the video, away, uncertain, or not measurable) by lecture
 * time. Nothing here is sent anywhere or saved, and no gaze coordinates are kept beyond the latest sample.
 */
export class GazeLiveStore {
  private latest: GazeSample | null = null;
  private receivedAt = 0;
  private active = false;
  private videoId: string | null = null;
  private bins = new Map<number, GazeBin>();
  private listeners = new Set<() => void>();
  private snap: { sample: GazeSample | null; active: boolean } = { sample: null, active: false };

  /** `null` means tracking stopped (camera off, recalibrating or lecture changed). */
  push = (sample: GazeSample | null, ctx?: { videoId: string | null; mediaTimeS: number; paused: boolean }): void => {
    if (!sample) {
      this.latest = null; this.active = false;
    } else {
      this.latest = sample; this.active = true; this.receivedAt = performance.now();
      if (ctx) {
        if (ctx.videoId !== this.videoId) { this.videoId = ctx.videoId; this.bins = new Map(); }
        // Only while the lecture is actually advancing, so a paused video does not smear one second of gaze.
        if (!ctx.paused && Number.isFinite(ctx.mediaTimeS)) {
          const key = Math.floor(ctx.mediaTimeS);
          const bin = this.bins.get(key) ?? { on: 0, off: 0, uncertain: 0, lost: 0 };
          bin[sample.state] += 1;
          this.bins.set(key, bin);
        }
      }
    }
    this.snap = { sample: this.latest, active: this.active };
    this.listeners.forEach((l) => l());
  };

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snap;
  /** The latest sample if it is still fresh; otherwise null (treat as not measurable). */
  fresh(now = performance.now()): GazeSample | null { return this.latest && now - this.receivedAt <= FRESH_MS ? this.latest : null; }
  isActive(): boolean { return this.active; }
  hasData(): boolean { return this.bins.size > 0; }

  /** The state a lecture second is best described by (most frequent), or 'none' when no frame was seen. */
  private stateOf(bin: GazeBin | undefined): GazeState | 'none' {
    if (!bin) return 'none';
    let best: GazeState = 'lost'; let n = -1;
    for (const k of ['lost', 'uncertain', 'on', 'off'] as const) if (bin[k] > n || (bin[k] === n && k !== 'lost')) { best = k; n = bin[k]; }
    return n > 0 ? best : 'none';
  }

  /** Contiguous same-state runs across [0, durationS). Seconds with no frames are 'none' (a gap, not 'away'). */
  runs(durationS: number): GazeRun[] {
    const end = Math.max(0, Math.ceil(durationS));
    const out: GazeRun[] = [];
    for (let s = 0; s < end; s++) {
      const state = this.stateOf(this.bins.get(s));
      const last = out[out.length - 1];
      if (last && last.state === state) last.endS = s + 1; else out.push({ startS: s, endS: s + 1, state });
    }
    return out;
  }

  /** Share of observed seconds in each state. `observedS` excludes seconds with no frames. */
  summary(durationS: number): { observedS: number; fractions: Record<GazeState, number> | null } {
    const counts: Record<GazeState, number> = { on: 0, off: 0, uncertain: 0, lost: 0 };
    let observed = 0;
    for (let s = 0; s < Math.ceil(durationS); s++) {
      const st = this.stateOf(this.bins.get(s));
      if (st !== 'none') { counts[st]++; observed++; }
    }
    return { observedS: observed, fractions: observed ? { on: counts.on / observed, off: counts.off / observed, uncertain: counts.uncertain / observed, lost: counts.lost / observed } : null };
  }
}

/** The freshest sample (null if stale or stopped), re-evaluated twice a second so a stalled camera is not shown as current. */
export function useGazeNow(store: GazeLiveStore): { sample: GazeSample | null; active: boolean } {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [, force] = useTick();
  useEffect(() => { const t = setInterval(force, 500); return () => clearInterval(t); }, [force]);
  return { sample: snap.active ? store.fresh() : null, active: snap.active };
}

import { useState } from 'react';
function useTick(): [number, () => void] {
  const [n, set] = useState(0);
  return [n, () => set((v) => v + 1)];
}
