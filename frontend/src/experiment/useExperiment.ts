import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttentionTimelineStore, useAttentionLecture } from '../attention';
import type { PlayerHandle } from '../player';
import { MAX_CSV_BYTES, type EegReplay } from './csv';
import { ExperimentReplay, type ExperimentReading } from './runtime';
import { GazeLiveStore, type GazeSample } from '../focus/gazeLive';
import { GazeWindowBuffer } from '../../../evaluation/player/gaze';

export function useExperiment(player: PlayerHandle | null, videoId: string | undefined) {
  const [store] = useState(() => new AttentionTimelineStore({ storage: null }));
  const [enabled, setEnabled] = useState(false);
  const [gazeMode, setGazeMode] = useState<'randomized' | 'webcam'>('randomized');
  const gazeSession = useMemo(() => ({ key: JSON.stringify([videoId, enabled, gazeMode]),
    live: new GazeLiveStore(), buffer: new GazeWindowBuffer() }), [videoId, enabled, gazeMode]);
  const { live: gazeLive, buffer: gazeBuffer } = gazeSession;
  const [source, setSource] = useState<{ replay: EegReplay; name: string } | null>(null);
  const [reading, setReading] = useState<ExperimentReading | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  useAttentionLecture(store, player);
  const onGazeSample = useCallback((sample: GazeSample | null) => {
    const state = player?.getState();
    gazeLive.push(sample, sample ? { videoId: videoId ?? null, mediaTimeS: state?.mediaTimeS ?? 0,
      paused: state?.paused ?? true } : undefined);
  }, [gazeLive, player, videoId]);

  // A source change starts a new experiment, never a mixture of mock and measured gaze.
  useEffect(() => { store.clear(); }, [gazeMode, store]);

  useEffect(() => () => { generation.current++; worker.current?.terminate(); }, []);
  useEffect(() => {
    setReading(null);
    if (!enabled) return;
    if (!source || !player || !videoId) {
      store.setAvailability({ state: 'unavailable', message: source ? 'Open a lecture to replay the EEG CSV.' : 'Import an EEG CSV in Session setup to begin the experiment.' });
      return;
    }
    const runtime = new ExperimentReplay(store, player, videoId, source.replay, setReading,
      Math.random, gazeMode === 'webcam' ? () => gazeLive.fresh() : undefined);
    runtime.start();
    return () => runtime.stop();
  }, [enabled, source, player, videoId, store, gazeMode, gazeLive]);

  const importCsv = async (file: File, sampleRate: number) => {
    const request = ++generation.current;
    worker.current?.terminate(); worker.current = null;
    setError(''); setSource(null); setReading(null); setLoading(true);
    store.clear();
    try {
      if (file.size > MAX_CSV_BYTES) throw new Error('Choose a CSV smaller than 20 MB.');
      const text = await file.text();
      if (generation.current !== request) return;
      const next = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' });
      worker.current = next;
      next.onmessage = (event: MessageEvent<{ replay?: EegReplay; error?: string }>) => {
        if (generation.current !== request) return;
        next.terminate(); worker.current = null; setLoading(false);
        if (event.data.replay) setSource({ replay: event.data.replay, name: file.name });
        else setError(event.data.error ?? 'Could not read EEG CSV.');
      };
      next.onerror = () => {
        if (generation.current !== request) return;
        next.terminate(); worker.current = null; setLoading(false); setError('Could not process EEG CSV. Try importing it again.');
      };
      next.postMessage({ text, sampleRate });
    } catch (e) {
      if (generation.current !== request) return;
      setLoading(false); setError(e instanceof Error ? e.message : 'Could not read EEG CSV.');
    }
  };
  return { enabled, setEnabled, store, source, reading, loading, error, importCsv,
    gazeMode, setGazeMode, gazeLive, gazeBuffer, gazeSessionKey: gazeSession.key, onGazeSample };
}
