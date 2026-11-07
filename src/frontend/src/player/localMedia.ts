/**
 * Local lecture files: validation, videoId derivation and readable error messages.
 * Owner: Person 4 (@aryanmorarji). The file is played from the user's device via an
 * object URL. It is never uploaded or sent to the backend; only `videoId` is.
 */

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg', 'mkv'];

export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
}

export type FileCheck = { ok: true } | { ok: false; reason: string };

/** Cheap pre-check before handing the file to <video>. The element still has the final say. */
export function checkVideoFile(file: FileLike): FileCheck {
  if (file.size === 0) return { ok: false, reason: `"${file.name}" is empty.` };
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const looksLikeVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext);
  if (!looksLikeVideo) {
    return { ok: false, reason: `"${file.name}" does not look like a video file (${file.type || 'unknown type'}).` };
  }
  return { ok: true };
}

/**
 * Stable id for a local file: "local-" + first 16 hex chars of SHA-256(name|size|lastModified).
 * Same file on the same device gives the same id; it does not read file contents, so it is
 * instant for large lectures. Matches the contract pattern ^[A-Za-z0-9][A-Za-z0-9_.:-]*$.
 * PROPOSED on the board (#1); change here only.
 */
export async function localVideoId(file: FileLike): Promise<string> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `local-${hex.slice(0, 16)}`;
}

/** Human-readable text for a MediaError code (HTMLMediaElement.error.code). */
export function describeMediaError(code: number | undefined): string {
  switch (code) {
    case 1:
      return 'Loading was stopped before the video could play.';
    case 2:
      return 'A read error stopped the video loading.';
    case 3:
      return 'The video could not be decoded. The file may be damaged or use an unsupported codec.';
    case 4:
      return 'This browser cannot play this video format. Try an MP4 (H.264) or WebM file.';
    default:
      return 'The video could not be played.';
  }
}

/** mm:ss, or h:mm:ss for an hour or more. Unknown -> "--:--". */
export function formatMediaTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
