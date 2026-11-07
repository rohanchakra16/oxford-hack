// Copies the MediaPipe WASM runtime and downloads the Face Landmarker model into public/,
// so the demo never depends on a CDN or venue Wi-Fi at runtime. Run once: `npm run setup`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmDst = join(root, "public/mediapipe/wasm");
const modelDst = join(root, "public/models/face_landmarker.task");
// Official Google-hosted model (Apache-2.0). Pinned to float16 v1.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

mkdirSync(wasmDst, { recursive: true });
for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(wasmDst, f));
console.log(`copied WASM runtime -> ${wasmDst}`);

if (existsSync(modelDst) && statSync(modelDst).size > 1_000_000) {
  console.log(`model already present -> ${modelDst}`);
} else {
  mkdirSync(dirname(modelDst), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(modelDst, buf);
  console.log(`downloaded model (${(buf.length / 1e6).toFixed(1)} MB) -> ${modelDst}`);
}
