import { parseEegCsv } from './csv';

self.onmessage = (event: MessageEvent<{ text: string; sampleRate: number }>) => {
  try { self.postMessage({ replay: parseEegCsv(event.data.text, event.data.sampleRate) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Could not read EEG CSV.' }); }
};
