import { useEffect, useRef, useState } from 'react';
import { AttentionTimelineStore, useAttentionLecture } from '../attention';
import type { PlayerHandle } from '../player';
import { MAX_CSV_BYTES, type EegReplay } from './csv';
import { ExperimentReplay, type ExperimentReading } from './runtime';

export function useExperiment(player: PlayerHandle | null, videoId: string | undefined) {
  const [store] = useState(() => new AttentionTimelineStore({ storage: null }));
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState<{ replay: EegReplay; name: string } | null>(null);
  const [reading, setReading] = useState<ExperimentReading | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  useAttentionLecture(store, player);

  useEffect(() => () => { generation.current++; worker.current?.terminate(); }, []);
  useEffect(() => {
    setReading(null);
    if (!enabled) return;
    if (!source || !player || !videoId) {
      store.setAvailability({ state: 'unavailable', message: source ? 'Open a lecture to replay the EEG CSV.' : 'Import an EEG CSV in Session setup to begin the experiment.' });
      return;
    }
    const runtime = new ExperimentReplay(store, player, videoId, source.replay, setReading);
    runtime.start();
    return () => runtime.stop();
  }, [enabled, source, player, videoId, store]);

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
  return { enabled, setEnabled, store, source, reading, loading, error, importCsv };
}
