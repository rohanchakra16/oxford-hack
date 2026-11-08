/** Clearly labelled Demo mode controls (#55). Simulated data only; see demo.ts. */
import { useEffect, useState } from 'react';
import { AttentionDemo, type DemoPlayback } from './demo';
import type { AttentionTimelineStore } from './store';

export function AttentionDemoPanel({ store, playback }: { store: AttentionTimelineStore; playback: DemoPlayback | null }) {
  const [demo, setDemo] = useState<AttentionDemo | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!playback) return;
    const d = new AttentionDemo(store, playback);
    setDemo(d);
    return () => {
      d.stop();
      setRunning(false);
    };
  }, [store, playback]);

  return (
    <section className="att-demo" aria-label="Demo mode">
      <div className="att-demo__head">
        <span className="att-badge att-badge--simulated">Demo mode</span>
        <p>Simulated attention data for presenting. Never mixed with real measurements.</p>
      </div>
      <div className="att-demo__actions">
        <button
          type="button"
          className="att-button att-button--outline"
          disabled={!demo}
          aria-pressed={running}
          onClick={() => {
            if (!demo) return;
            if (demo.running) demo.stop();
            else demo.start();
            setRunning(demo.running);
          }}
        >
          {running ? 'Stop simulated data' : 'Start simulated data'}
        </button>
        <button type="button" className="att-button att-button--outline" disabled={!demo || !running} onClick={() => demo?.triggerDip()}>
          Simulate attention drop
        </button>
        <button type="button" className="att-button att-button--quiet" disabled={!demo} onClick={() => demo?.addBookmark()}>
          Simulated bookmark
        </button>
        <button type="button" className="att-button att-button--quiet" onClick={() => store.clearSimulated()}>
          Clear simulated data
        </button>
      </div>
    </section>
  );
}
