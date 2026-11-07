import {
  DEFAULT_PHASES,
  GazeEngine,
  scoreValidation,
  screenToViewport,
  type CalibrationModel,
  type CalibrationUI,
  type GazeObservation,
  type GazeSummary,
  type PhaseWindow,
  type ValidationResult,
} from "../index";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const lecture = $<HTMLVideoElement>("lecture");
const lectureWrap = $("lecture-wrap");
const cam = $<HTMLVideoElement>("cam");
const overlay = $<HTMLCanvasElement>("cam-overlay");
const dot = $("gaze-dot");
const calOverlay = $("cal-overlay");
const calTarget = $("cal-target");
const calText = $("cal-text");
const message = $("message");

const sessionId = `harness-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const engine = new GazeEngine({
  sessionId,
  getVideoElement: () => lecture,
  cameraVideo: cam,
});

// ---------- status chips ----------
function chip(id: string, text: string, tone: "ok" | "bad" | "warn" | "" = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `chip ${tone}`;
}

function dl(id: string, rows: [string, string | number | null | undefined][]) {
  $(id).innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v === null || v === undefined ? "—" : v}</dd>`)
    .join("");
}

engine.on("camera", (s) => {
  if (s.status === "live") chip("chip-camera", `camera: ${s.width}×${s.height}`, "ok");
  else if (s.status === "error") chip("chip-camera", `camera: ${s.reason}`, "bad");
  else chip("chip-camera", `camera: ${s.status}`);
  $("cam-empty").hidden = s.status === "live";
  for (const id of ["btn-cal", "btn-pursuit", "btn-validate"]) ($(id) as HTMLButtonElement).disabled = s.status !== "live";
  if (s.status === "error") message.textContent = `Camera problem: ${s.message}`;
});

function showCalibration(m: CalibrationModel | null) {
  ($("btn-clear") as HTMLButtonElement).disabled = !m;
  if (!m) {
    chip("chip-cal", "calibration: none");
    dl("cal-info", [["status", "none"]]);
    return;
  }
  const tone = m.quality === "fine" ? "ok" : m.quality === "coarse" ? "warn" : "bad";
  chip("chip-cal", `calibration: ${m.quality} (±${Math.round(m.heldoutRmsPx)} px)`, tone);
  const method = m.method ?? "dots";
  dl("cal-info", [
    ["method", method === "pursuit" ? `moving dot (eye lag ${m.lagMs} ms)` : "dots"],
    ["quality", m.quality],
    ["held-out RMS", `${Math.round(m.heldoutRmsPx)} px`],
    [
      method === "pursuit" ? "held-out blocks" : "held-out errors",
      m.heldoutErrorsPx.map((e) => Math.round(e)).join(", ") + " px",
    ],
    ["fit RMS", `${Math.round(m.fitRmsPx)} px${m.fitSamples ? ` (${m.fitSamples} samples)` : ""}`],
    ["edge margin", `${Math.round(m.marginPx)} px`],
    ["id", m.id],
  ]);
}
engine.on("calibration", (m) => {
  showCalibration(m);
  try {
    if (m) localStorage.setItem("gaze-harness-calibration-v2", JSON.stringify(m));
    else localStorage.removeItem("gaze-harness-calibration-v2");
  } catch {
    /* storage unavailable: calibration just won't persist */
  }
});

// ---------- per-frame display ----------
let frames = 0;
let procSum = 0;
setInterval(() => {
  chip("chip-perf", `${frames} fps · ${frames ? (procSum / frames).toFixed(1) : "—"} ms/frame`);
  frames = 0;
  procSum = 0;
}, 1000);

const ctx = overlay.getContext("2d")!;
const EYE_POINTS = [33, 133, 159, 145, 263, 362, 386, 374];
engine.on("frame", (f) => {
  frames++;
  procSum += f.processingMs;
  overlay.width = cam.videoWidth;
  overlay.height = cam.videoHeight;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!f.landmarks) return;
  const W = overlay.width;
  const H = overlay.height;
  ctx.fillStyle = "#7c9cff";
  for (const i of EYE_POINTS) ctx.fillRect(f.landmarks[i].x * W - 2, f.landmarks[i].y * H - 2, 4, 4);
  ctx.fillStyle = "#ef6a55";
  for (const i of [468, 473]) {
    ctx.beginPath();
    ctx.arc(f.landmarks[i].x * W, f.landmarks[i].y * H, 4, 0, Math.PI * 2);
    ctx.fill();
  }
});

const fmt = (v: number | null, unit = "", d = 1) => (v === null ? null : `${v.toFixed(d)}${unit}`);
engine.on("observation", (o: GazeObservation) => {
  record(o);
  const region = o.gaze.region;
  lectureWrap.classList.remove("on_video", "off_video", "uncertain");
  if (region) lectureWrap.classList.add(region);
  chip(
    "chip-region",
    `region: ${region ?? "unavailable"}`,
    region === "on_video" ? "ok" : region === "off_video" ? "bad" : region === "uncertain" ? "warn" : "",
  );

  const showDot = ($("show-dot") as HTMLInputElement).checked && o.gaze.screen_x_px !== null;
  dot.hidden = !showDot;
  if (showDot) {
    const p = screenToViewport({ x: o.gaze.screen_x_px!, y: o.gaze.screen_y_px! });
    dot.style.left = `${p.x}px`;
    dot.style.top = `${p.y}px`;
    dot.className = region ?? "";
  }

  dl("live-info", [
    ["status", o.status],
    ["reasons", o.reasons.join(", ") || "none"],
    ["head yaw / pitch", o.face.head_yaw_deg === null ? null : `${o.face.head_yaw_deg}° / ${o.face.head_pitch_deg}°`],
    ["iris x / y", o.face.iris_x === null ? null : `${o.face.iris_x} / ${o.face.iris_y}`],
    ["eye openness", fmt(o.face.eye_openness, "", 2)],
    ["eyes closed", o.face.eyes_closed === null ? null : String(o.face.eyes_closed)],
    ["video u / v", o.gaze.video_u === null ? null : `${o.gaze.video_u.toFixed(2)} / ${o.gaze.video_v!.toFixed(2)}`],
    ["head moved since cal.", fmt(o.face.pose_shift, "", 3)],
    ["distance vs cal.", fmt(o.face.scale_ratio, "×", 2)],
  ]);
});

const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);
engine.on("summary", (s: GazeSummary) => {
  record(s);
  dl("summary-info", [
    ["frames", s.frames_processed],
    ["valid coverage", pct(s.valid_coverage)],
    ["on / off / uncertain", s.on_video_fraction === null ? null : `${pct(s.on_video_fraction)} / ${pct(s.off_video_fraction)} / ${pct(s.uncertain_fraction)}`],
    ["longest off-video", `${Math.round(s.longest_off_video_ms)} ms`],
    ["face missing", pct(s.face_missing_fraction)],
    ["eyes closed", pct(s.eyes_closed_fraction)],
    ["top reasons", s.top_reasons.join(", ") || "none"],
  ]);
});

// ---------- controls ----------
$("btn-start").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("btn-start");
  btn.disabled = true;
  message.textContent = "Loading face model…";
  try {
    await engine.start();
    const s = engine.camera.state;
    if (s.status === "error") {
      message.textContent = `Camera unavailable (${s.reason}): ${s.message}`;
      btn.disabled = false;
    } else {
      message.textContent = "Tracking locally. Calibrate with your head in your normal viewing position.";
    }
  } catch (err) {
    message.textContent = `Failed to start: ${(err as Error).message}`;
    btn.disabled = false;
  }
});

let calAbort: AbortController | null = null;
const calibrationUI: CalibrationUI = {
  show(p, progress, total, moving) {
    calOverlay.hidden = false;
    calTarget.classList.toggle("moving", !!moving);
    calTarget.style.left = `${p.x}px`;
    calTarget.style.top = `${p.y}px`;
    calText.textContent = moving
      ? `Follow the dot with your eyes as you'd normally watch. Keep your seat still (${Math.ceil((total - progress) / 1000)} s) · Esc to cancel`
      : `Look at the dot as you'd normally watch. Keep your seat still (${progress + 1}/${total}) · Esc to cancel`;
  },
  hide() {
    calOverlay.hidden = true;
  },
};

async function runCalibration(kind: "dots" | "pursuit") {
  calAbort = new AbortController();
  message.textContent = "";
  try {
    const m =
      kind === "pursuit"
        ? await engine.calibratePursuit(calibrationUI, { signal: calAbort.signal })
        : await engine.calibrate(calibrationUI, { signal: calAbort.signal });
    message.textContent =
      m.quality === "unusable"
        ? "Calibration too inaccurate to locate gaze; head pose is still reported. Try better lighting or sit closer."
        : `Calibrated: held-out error about ${Math.round(m.heldoutRmsPx)} px. Run the accuracy test to see if it separates looking at vs. away from the video.`;
  } catch (err) {
    message.textContent = `Calibration did not complete: ${(err as Error).message}`;
  } finally {
    calAbort = null;
  }
}
$("btn-cal").addEventListener("click", () => runCalibration("dots"));
$("btn-pursuit").addEventListener("click", () => runCalibration("pursuit"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    calAbort?.abort();
    valAbort?.abort();
  }
});

// ---------- look-away accuracy test ----------
let valAbort: AbortController | null = null;
let valObservations: GazeObservation[] | null = null;
engine.on("observation", (o) => valObservations?.push(o));

let audio: AudioContext | null = null;
function beep(freq = 880) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {
    /* audio unavailable; the banner still updates */
  }
}

const shortReason = (r: string) =>
  r.replace("CALIBRATION_", "cal ").replace("CAMERA_", "camera ").replace(/_/g, " ").toLowerCase();

function showValidation(r: ValidationResult) {
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const n2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const rows = r.phases
    .map(
      (p) =>
        `<tr><td>${p.id}</td><td>${p.expected === "on_video" ? "on" : "off"}</td><td>${pct(p.correctFraction)}</td>` +
        `<td>${p.on}/${p.off}/${p.uncertain}/${p.unavailable}</td>` +
        `<td>${p.mainUnavailableReason ? shortReason(p.mainUnavailableReason) : "—"}</td></tr>`,
    )
    .join("");
  const drift = r.phases
    .map(
      (p) =>
        `<tr><td>${p.id}</td><td>${n2(p.medianVideoU)}, ${n2(p.medianVideoV)}</td>` +
        `<td>${n2(p.medianPoseShift)}</td><td>${n2(p.medianScaleRatio)}</td></tr>`,
    )
    .join("");
  $("val-info").innerHTML = `
    <dl>
      <dt></dt><dd><b>gaze only</b> · <b>incl. face lost</b></dd>
      <dt>look-away detected</dt><dd>${pct(r.lookAwayDetectionRate)} · ${pct(r.lookAwayInclFaceLost)}</dd>
      <dt>false alarms</dt><dd>${pct(r.falseAlarmRate)} · ${pct(r.falseAlarmInclFaceLost)}</dd>
      <dt>balanced accuracy</dt><dd>${pct(r.balancedAccuracy)} · ${pct(r.balancedAccuracyInclFaceLost)}</dd>
      <dt>on-video confirmed</dt><dd>${pct(r.onVideoConfirmRate)}</dd>
      <dt>coverage</dt><dd>${pct(r.coverage)}</dd>
    </dl>
    <table class="val">
      <thead><tr><th>phase</th><th>expect</th><th>correct</th><th>on/off/unc/na</th><th>why na</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>Drift diagnostics</h2>
    <p class="hint">Median estimate position in the video (0.5, 0.5 = centre; above 1 = past the right/bottom edge), head movement since calibration (fraction of camera image), and distance change (1 = same as calibration). If on-video steps drift away from the centre as head movement grows, drift is the cause.</p>
    <table class="val">
      <thead><tr><th>phase</th><th>u, v</th><th>head moved</th><th>distance</th></tr></thead>
      <tbody>${drift}</tbody>
    </table>`;
}

$("btn-validate").addEventListener("click", async () => {
  if (!engine.getCalibration()) {
    message.textContent = "Calibrate first; without calibration every frame is 'unavailable'.";
    return;
  }
  valAbort = new AbortController();
  const signal = valAbort.signal;
  const banner = $("val-banner");
  const btn = $<HTMLButtonElement>("btn-validate");
  btn.disabled = true;
  banner.hidden = false;
  valObservations = [];
  const windows: PhaseWindow[] = [];
  const total = DEFAULT_PHASES.reduce((s, p) => s + p.durationMs, 0);
  const t0 = performance.now();
  try {
    for (const [i, phase] of DEFAULT_PHASES.entries()) {
      const startMs = performance.now();
      $("val-step").textContent = `Step ${i + 1} of ${DEFAULT_PHASES.length} · Esc to cancel`;
      $("val-instruction").textContent = phase.instruction;
      beep(phase.expected === "on_video" ? 880 : 660);
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (signal.aborted) return reject(new DOMException("cancelled", "AbortError"));
          const now = performance.now();
          $("val-progress").style.width = `${Math.min(100, ((now - t0) / total) * 100)}%`;
          if (now - startMs >= phase.durationMs) return resolve();
          requestAnimationFrame(tick);
        };
        tick();
      });
      windows.push({ phase, startMs, endMs: performance.now() });
    }
    beep(1200);
    const result = scoreValidation(windows, valObservations);
    showValidation(result);
    $("val-heading").scrollIntoView({ behavior: "smooth", block: "start" });
    record({ type: "validation_result", calibration: engine.getCalibration(), result, windows });
    message.textContent = "Accuracy test complete.";
  } catch {
    message.textContent = "Accuracy test cancelled.";
  } finally {
    valObservations = null;
    valAbort = null;
    banner.hidden = true;
    btn.disabled = false;
  }
});
$("btn-val-cancel").addEventListener("click", () => valAbort?.abort());

$("btn-clear").addEventListener("click", () => engine.setCalibration(null));
$("small-video").addEventListener("change", (e) =>
  lectureWrap.classList.toggle("small", (e.target as HTMLInputElement).checked),
);
$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  lecture.src = URL.createObjectURL(file);
  $("lecture-placeholder").hidden = true;
});

// ---------- fixture recording (in memory only until downloaded) ----------
let recording = false;
let recorded: unknown[] = [];
function record(msg: unknown) {
  if (!recording) return;
  recorded.push(msg);
  $("rec-count").textContent = `${recorded.length} messages`;
}
$("btn-rec").addEventListener("click", () => {
  recording = !recording;
  if (recording) {
    recorded = [
      {
        type: "fixture_header",
        session_id: sessionId,
        created: new Date().toISOString(),
        calibration: engine.getCalibration(),
        note: "Gaze messages only; no images. Recorded with the gaze harness.",
      },
    ];
  }
  $("btn-rec").textContent = recording ? "Stop" : "Record";
  $<HTMLButtonElement>("btn-dl").disabled = recording || recorded.length === 0;
});
$("btn-dl").addEventListener("click", () => {
  const blob = new Blob([recorded.map((r) => JSON.stringify(r)).join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sessionId}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- restore last calibration (convenience; staleness checks still apply) ----------
try {
  const saved = localStorage.getItem("gaze-harness-calibration-v2");
  if (saved) {
    engine.setCalibration(JSON.parse(saved) as CalibrationModel);
    message.textContent = "Restored previous calibration. Recalibrate if you've moved.";
  }
} catch {
  /* ignore */
}
