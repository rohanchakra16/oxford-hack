/**
 * Startup checks for the gaze module's model files, and typed startup errors.
 *
 * The face model and the MediaPipe WASM runtime are git-ignored and copied into gaze/public/ by
 * `npm --prefix gaze run setup`. When they are missing, a single-page-app dev server answers their
 * URLs with HTTP 200 and its index.html, and MediaPipe then fails with an unhelpful error. Checking
 * the responses first lets us say exactly what is missing and how to fix it.
 */

export type GazeStartupErrorKind =
  /** Model or WASM files are missing, or the server returns something else for them. */
  | "assets_missing"
  /** Files look right but MediaPipe could not create the face model (WASM/WebGL/browser problem). */
  | "model_load_failed";

export class GazeStartupError extends Error {
  readonly kind: GazeStartupErrorKind;
  readonly problems: AssetProblem[];
  constructor(kind: GazeStartupErrorKind, message: string, problems: AssetProblem[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GazeStartupError";
    this.kind = kind;
    this.problems = problems;
  }
}

export interface AssetProblem {
  url: string;
  what: string;
  problem: string;
}

interface AssetSpec {
  url: string;
  what: string;
  /** Expected signature bytes, if the format has one. */
  magic?: number[];
  /** Search for the signature within this many leading bytes (default: it must be at offset 0). */
  magicWithin?: number;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"
// .task model bundles are zip archives; the published face_landmarker.task has two zero bytes before the
// local-file header, so search near the start instead of requiring offset 0.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export const SETUP_HINT =
  "Run `npm --prefix gaze run setup` (copies the MediaPipe WASM runtime and downloads the face model into gaze/public/), " +
  "and check that the app serves gaze/public/ so these URLs return the files.";

function joinUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, "")}/${file}`;
}

export function gazeAssetSpecs(paths: { wasmBasePath: string; modelAssetPath: string }): AssetSpec[] {
  return [
    { url: paths.modelAssetPath, what: "face model", magic: ZIP_MAGIC, magicWithin: 64 },
    { url: joinUrl(paths.wasmBasePath, "vision_wasm_internal.wasm"), what: "MediaPipe WASM runtime", magic: WASM_MAGIC },
    { url: joinUrl(paths.wasmBasePath, "vision_wasm_internal.js"), what: "MediaPipe WASM loader" },
  ];
}

async function firstBytes(res: Response, n: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, n);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    // Only the signature is needed; MediaPipe fetches the file itself (usually from the HTTP cache).
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(n, total));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - offset);
    out.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}

async function checkOne(spec: AssetSpec, fetchFn: typeof fetch): Promise<AssetProblem | null> {
  let res: Response;
  try {
    res = await fetchFn(spec.url, { cache: "no-cache" });
  } catch (err) {
    return { ...spec, problem: `request failed (${(err as Error)?.message ?? String(err)})` };
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ...spec, problem: `HTTP ${res.status}` };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    void res.body?.cancel().catch(() => {});
    return { ...spec, problem: "the server returned an HTML page instead (usually its fallback page because the file is missing)" };
  }
  if (spec.magic) {
    const magic = spec.magic;
    const head = await firstBytes(res, spec.magicWithin ?? magic.length);
    const lastStart = spec.magicWithin ? head.length - magic.length : 0;
    let found = false;
    for (let at = 0; at <= lastStart && !found; at++) found = magic.every((b, i) => head[at + i] === b);
    if (!found) {
      return { ...spec, problem: "the response is not a valid file of this type (wrong or truncated content)" };
    }
  } else {
    void res.body?.cancel().catch(() => {});
  }
  return null;
}

/** Checks that the model and WASM files are served correctly. Returns the problems found (empty if fine). */
export async function checkGazeAssets(
  paths: { wasmBasePath: string; modelAssetPath: string },
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AssetProblem[]> {
  const results = await Promise.all(gazeAssetSpecs(paths).map((s) => checkOne(s, fetchFn)));
  return results.filter((r): r is AssetProblem => r !== null);
}

export function assetsMissingError(problems: AssetProblem[]): GazeStartupError {
  const list = problems.map((p) => `${p.what} at ${p.url}: ${p.problem}`).join("; ");
  return new GazeStartupError("assets_missing", `Gaze model files are missing or not served correctly. ${list}. ${SETUP_HINT}`, problems);
}

export function modelLoadError(cause: unknown): GazeStartupError {
  const detail = (cause as Error)?.message ?? String(cause);
  return new GazeStartupError(
    "model_load_failed",
    `The gaze face model could not be loaded (${detail}). The model files are present, so this is a browser WASM/WebGL problem: ` +
      "reload the page, close other tabs using the camera or GPU, or try another Chromium-based browser. The browser console has details.",
    [],
    { cause },
  );
}
