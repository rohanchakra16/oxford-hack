import { describe, expect, it } from "vitest";
import { assetsMissingError, checkGazeAssets, GazeStartupError, modelLoadError, SETUP_HINT } from "./assets";
import { cameraError } from "./camera";

// Tests run in Node; the package has no @types/node, so type the two fs calls used here.
const fs = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as {
  existsSync(path: URL): boolean;
  readFileSync(path: URL): Uint8Array;
};
const { existsSync, readFileSync } = fs;

const PATHS = { wasmBasePath: "/mediapipe/wasm", modelAssetPath: "/models/face_landmarker.task" };
const MODEL = "/models/face_landmarker.task";
const WASM = "/mediapipe/wasm/vision_wasm_internal.wasm";
const LOADER = "/mediapipe/wasm/vision_wasm_internal.js";

const bytes = (...b: number[]) => new Uint8Array([...b, 1, 2, 3, 4, 5, 6, 7, 8]);
const good: Record<string, () => Response> = {
  // Like the real face_landmarker.task: two zero bytes, then the zip header.
  [MODEL]: () => new Response(bytes(0x00, 0x00, 0x50, 0x4b, 0x03, 0x04), { headers: { "content-type": "application/octet-stream" } }),
  [WASM]: () => new Response(bytes(0x00, 0x61, 0x73, 0x6d), { headers: { "content-type": "application/wasm" } }),
  [LOADER]: () => new Response("var Module = {};", { headers: { "content-type": "text/javascript" } }),
};
const spaFallback = () =>
  new Response("<!doctype html><html><body><div id=root></div></body></html>", { headers: { "content-type": "text/html" } });

function fakeFetch(overrides: Record<string, () => Response | Promise<Response>> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const make = overrides[url] ?? good[url];
    if (!make) return new Response("not found", { status: 404 });
    return make();
  }) as typeof fetch;
}

describe("checkGazeAssets", () => {
  it("passes when the model and WASM files are served", async () => {
    expect(await checkGazeAssets(PATHS, fakeFetch())).toEqual([]);
  });

  it("flags the dev server's HTML fallback (the design-2 demo failure)", async () => {
    const problems = await checkGazeAssets(PATHS, fakeFetch({ [MODEL]: spaFallback, [WASM]: spaFallback, [LOADER]: spaFallback }));
    expect(problems.map((p) => p.url)).toEqual([MODEL, WASM, LOADER]);
    expect(problems.every((p) => p.problem.includes("HTML page"))).toBe(true);
  });

  it("flags HTTP errors, wrong content and network failures", async () => {
    const problems = await checkGazeAssets(
      PATHS,
      fakeFetch({
        [MODEL]: () => new Response("missing", { status: 404 }),
        [WASM]: () => new Response(bytes(0x7b, 0x22, 0x61, 0x22), { headers: { "content-type": "application/wasm" } }),
        [LOADER]: () => Promise.reject(new TypeError("Failed to fetch")),
      }),
    );
    expect(problems).toEqual([
      expect.objectContaining({ url: MODEL, problem: "HTTP 404" }),
      expect.objectContaining({ url: WASM, problem: expect.stringContaining("not a valid file") }),
      expect.objectContaining({ url: LOADER, problem: expect.stringContaining("Failed to fetch") }),
    ]);
  });

  it("flags a truncated model file", async () => {
    const problems = await checkGazeAssets(PATHS, fakeFetch({ [MODEL]: () => new Response(new Uint8Array([0x50, 0x4b])) }));
    expect(problems).toEqual([expect.objectContaining({ url: MODEL, problem: expect.stringContaining("not a valid file") })]);
  });

  // Checks the real files from `npm run setup` when present (git-ignored, so absent in a fresh clone).
  const realModel = new URL("../public/models/face_landmarker.task", import.meta.url);
  const realWasm = new URL("../public/mediapipe/wasm/vision_wasm_internal.wasm", import.meta.url);
  it.skipIf(!existsSync(realModel) || !existsSync(realWasm))("accepts the real downloaded model and WASM files", async () => {
    const serve = (file: URL) => () => new Response(new Uint8Array(readFileSync(file).subarray(0, 256)));
    expect(await checkGazeAssets(PATHS, fakeFetch({ [MODEL]: serve(realModel), [WASM]: serve(realWasm) }))).toEqual([]);
  });

  it("still requires the WASM signature at the very start", async () => {
    const problems = await checkGazeAssets(PATHS, fakeFetch({ [WASM]: () => new Response(bytes(0x00, 0x00, 0x61, 0x73, 0x6d)) }));
    expect(problems).toEqual([expect.objectContaining({ url: WASM })]);
  });

  it("joins a base path given with a trailing slash", async () => {
    expect(await checkGazeAssets({ ...PATHS, wasmBasePath: "/mediapipe/wasm/" }, fakeFetch())).toEqual([]);
  });
});

describe("startup errors", () => {
  it("names each missing file and the setup command", () => {
    const e = assetsMissingError([{ url: MODEL, what: "face model", problem: "HTTP 404" }]);
    expect(e).toBeInstanceOf(GazeStartupError);
    expect(e.kind).toBe("assets_missing");
    expect(e.message).toContain(`face model at ${MODEL}: HTTP 404`);
    expect(e.message).toContain(SETUP_HINT);
    expect(e.problems).toHaveLength(1);
  });

  it("reports a load failure as a browser problem, not missing files or the camera", () => {
    const e = modelLoadError(new Error("WebGL context lost"));
    expect(e.kind).toBe("model_load_failed");
    expect(e.message).toContain("WebGL context lost");
    expect(e.message).not.toMatch(/permission/i);
  });
});

describe("cameraError", () => {
  it("maps getUserMedia failures to reasons with an action", () => {
    expect(cameraError("NotAllowedError", "denied")).toMatchObject({ reason: "CAMERA_PERMISSION_DENIED", message: expect.stringContaining("Allow camera access") });
    expect(cameraError("NotReadableError", "busy")).toMatchObject({ reason: "CAMERA_IN_USE", message: expect.stringContaining("Close other apps") });
    expect(cameraError("NotFoundError", "none")).toMatchObject({ reason: "CAMERA_NOT_FOUND", message: expect.stringContaining("No camera") });
    expect(cameraError("WeirdError", "odd failure")).toMatchObject({ reason: "CAMERA_NOT_FOUND", message: expect.stringContaining("odd failure") });
  });
});
