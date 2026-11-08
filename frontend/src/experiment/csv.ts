export interface EegReplay {
  points: { timeS: number; score: number | null }[];
  durationS: number;
  method: 'scores' | 'spectral';
}

export const MAX_CSV_BYTES = 20 * 1024 * 1024;

/** Local-only test input. Missing signal is a gap, never a zero attention score. */
export function parseEegCsv(text: string, sampleRate = 250): EegReplay {
  if (text.length > MAX_CSV_BYTES) throw new Error('Choose a CSV smaller than 20 MB.');
  if (!Number.isFinite(sampleRate) || sampleRate < 64 || sampleRate > 1000) throw new Error('Raw EEG sample rate must be between 64 and 1000 Hz.');
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const header = rows.shift()?.map((cell) => cell.trim().toLowerCase().replace(/[\s-]+/g, '_')) ?? [];
  if (!header.length || !rows.length) throw new Error('CSV needs a header and data rows.');
  if (new Set(header).size !== header.length || header.some((h) => !h)) throw new Error('CSV column names must be unique and nonempty.');
  if (rows.some((row) => row.length !== header.length)) throw new Error('Every CSV row must have the same number of columns as the header.');
  const timeColumn = header.findIndex((h) => ['timestamp', 'time', 'time_s', 'timestamp_s', 'time_ms', 'timestamp_ms'].includes(h));
  const scoreColumn = header.findIndex((h) => ['attention_score', 'attention', 'score'].includes(h));
  const channels = header.flatMap((h, i) => i !== timeColumn && i !== scoreColumn && !['sample_index', 'index', 'label'].includes(h) ? [i] : []);
  if (scoreColumn < 0 && (!channels.length || channels.length > 32)) throw new Error('Include attention_score (0–100), or 1–32 numeric EEG channel columns.');
  const step = scoreColumn >= 0 ? 1 : 1 / sampleRate;
  const timeScale = timeColumn >= 0 && header[timeColumn]!.endsWith('_ms') ? .001 : 1;
  const offset = timeColumn < 0 ? 0 : numeric(rows[0]![timeColumn]!) * timeScale;
  const times = rows.map((row, i) => timeColumn < 0 ? i * step : numeric(row[timeColumn]!) * timeScale - offset);
  if (times.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= times[i - 1]!))) throw new Error('Timestamps must be numeric and strictly increasing (seconds, or a time_ms column).');
  if (scoreColumn >= 0) {
    const points = rows.map((row, i) => {
      const score = numeric(row[scoreColumn]!);
      if (Number.isFinite(score) && (score < 0 || score > 100)) throw new Error('Attention scores must be on a 0–100 scale.');
      return { timeS: times[i]!, score: Number.isFinite(score) ? score : null };
    });
    if (!points.some((p) => p.score !== null)) throw new Error('No usable attention scores were found.');
    // Sparse score files are not held across missing intervals.
    const interval = points.length > 1 ? Math.min(10, median(times.slice(1).map((t, i) => t - times[i]!))) : 1;
    const withGaps = points.flatMap((point, i) => i && point.timeS - points[i - 1]!.timeS > interval * 1.5
      ? [{ timeS: points[i - 1]!.timeS + interval, score: null }, point] : [point]);
    return { points: withGaps, durationS: times[times.length - 1]! + interval, method: 'scores' };
  }
  const dt = times.slice(1).map((t, i) => t - times[i]!);
  const rate = timeColumn < 0 ? sampleRate : 1 / median(dt);
  if (!Number.isFinite(rate) || rate < 64 || rate > 1000) throw new Error('Raw EEG timestamps must describe 64–1000 samples per second.');
  const size = Math.round(rate * 2);
  const points: EegReplay['points'] = [];
  for (let start = 0; start + size <= rows.length; start += size) {
    const stop = start + size;
    const continuous = times.slice(start + 1, stop).every((t, i) => Math.abs(t - times[start + i]! - 1 / rate) <= .25 / rate);
    const values = channels.map((channel) => rows.slice(start, stop).map((row) => numeric(row[channel]!)));
    const valid = continuous && values.every((v) => v.every(Number.isFinite));
    const scores = valid ? values.map((v) => spectralProxy(v, rate)) : [];
    const usable = scores.filter((s): s is number => s !== null);
    points.push({ timeS: times[start]!, score: usable.length === channels.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null });
    if (start && times[start]! - times[start - size]! > 2.5) points.splice(points.length - 1, 0, { timeS: times[start - size]! + 2, score: null });
  }
  if (!points.some((p) => p.score !== null)) throw new Error('Need at least two seconds of continuous, non-flat numeric EEG samples.');
  return { points, durationS: points[points.length - 1]!.timeS + 2, method: 'spectral' };
}

function numeric(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell.trim()); cell = '';
      if (char !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else cell += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** Hann-windowed FFT proxy: beta / (theta + beta). For testing, not a trained model. */
function spectralProxy(values: number[], rate: number): number | null {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let n = 1;
  while (n < values.length) n *= 2;
  const real = new Float64Array(n), imaginary = new Float64Array(n);
  values.forEach((value, i) => { real[i] = (value - mean) * (.5 - .5 * Math.cos(2 * Math.PI * i / (values.length - 1))); });
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j]!, real[i]!];
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = -2 * Math.PI / length;
    for (let start = 0; start < n; start += length) {
      for (let k = 0; k < length / 2; k++) {
        const even = start + k, odd = even + length / 2;
        const c = Math.cos(angle * k), s = Math.sin(angle * k);
        const r = real[odd]! * c - imaginary[odd]! * s, im = real[odd]! * s + imaginary[odd]! * c;
        real[odd] = real[even]! - r; imaginary[odd] = imaginary[even]! - im;
        real[even] = real[even]! + r; imaginary[even] = imaginary[even]! + im;
      }
    }
  }
  let theta = 0, beta = 0;
  for (let i = 1; i <= n / 2; i++) {
    const hz = i * rate / n, power = real[i]! ** 2 + imaginary[i]! ** 2;
    if (hz >= 4 && hz < 8) theta += power;
    if (hz >= 13 && hz <= 30) beta += power;
  }
  return theta + beta > 1e-12 ? 100 * beta / (theta + beta) : null;
}

export function replayScore(replay: EegReplay, mediaS: number): number | null {
  if (mediaS < 0 || mediaS >= replay.durationS) return null;
  let left = 0, right = replay.points.length - 1;
  while (left < right) {
    const mid = Math.ceil((left + right) / 2);
    if (replay.points[mid]!.timeS <= mediaS) left = mid;
    else right = mid - 1;
  }
  return replay.points[left]?.score ?? null;
}
