export interface TranscriptCue {
  startS: number;
  endS: number;
  text: string;
}

const timestampPattern = String.raw`(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{1,3})`;
const timingLine = new RegExp(`^${timestampPattern}\\s+-->\\s+${timestampPattern}(?:\\s+.*)?$`);

function timestampToSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  milliseconds: string,
): number {
  return Number(hours ?? 0) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds.padEnd(3, '0')) / 1000;
}

function cleanCaptionText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

export function parseTranscript(value: string): TranscriptCue[] {
  const lines = value.replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues: TranscriptCue[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.trim().match(timingLine);
    if (!match) continue;

    const startS = timestampToSeconds(match[1], match[2]!, match[3]!, match[4]!);
    const endS = timestampToSeconds(match[5], match[6]!, match[7]!, match[8]!);
    if (endS < startS) continue;

    const textLines: string[] = [];
    for (index += 1; index < lines.length && lines[index]?.trim(); index += 1) {
      const line = lines[index]!.trim();
      if (timingLine.test(line)) {
        index -= 1;
        break;
      }
      textLines.push(line);
    }

    const text = cleanCaptionText(textLines.join(' ').replace(/\s+/g, ' '));
    if (text) cues.push({ startS, endS, text });
  }

  return cues;
}

export function replayPassage(
  cues: TranscriptCue[],
  suggestedTimeS: number,
  earlierCount = 0,
): (TranscriptCue & { index: number }) | null {
  if (cues.length === 0) return null;

  let index = cues.findIndex((cue) => suggestedTimeS >= cue.startS && suggestedTimeS <= cue.endS);
  if (index < 0) {
    const firstFollowing = cues.findIndex((cue) => cue.startS > suggestedTimeS);
    index = firstFollowing < 0 ? cues.length - 1 : Math.max(0, firstFollowing - 1);
  }

  index = Math.max(0, index - Math.max(0, Math.floor(earlierCount)));
  return { ...cues[index]!, index };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const clock = `${String(minutes).padStart(1, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : clock;
}
