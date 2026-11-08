import type { GazeReasonCode } from "./types";

export type CameraState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "live"; label: string; width: number; height: number }
  | { status: "error"; reason: GazeReasonCode; message: string };

/** Maps a getUserMedia failure to a reason code and a message that says what to do. */
export function cameraError(name: string | undefined, raw: string): { reason: GazeReasonCode; message: string } {
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      reason: "CAMERA_PERMISSION_DENIED",
      message: "Camera permission was denied. Allow camera access for this site (camera icon in the address bar, or the system privacy settings), then try again.",
    };
  if (name === "NotReadableError" || name === "AbortError")
    return {
      reason: "CAMERA_IN_USE",
      message: "The camera is busy or could not be started. Close other apps or tabs using it, then try again.",
    };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { reason: "CAMERA_NOT_FOUND", message: "No camera was found. Connect a camera, then try again." };
  return { reason: "CAMERA_NOT_FOUND", message: `The camera could not be started (${raw}).` };
}

/** Wraps getUserMedia with explicit failure states and reconnection on device changes. */
export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private _state: CameraState = { status: "idle" };
  private listeners = new Set<(s: CameraState) => void>();
  private wantRunning = false;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      if (this.wantRunning && this._state.status === "error") void this.start();
    });
  }

  get state(): CameraState {
    return this._state;
  }

  onChange(fn: (s: CameraState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: CameraState) {
    this._state = s;
    for (const fn of this.listeners) fn(s);
  }

  async start(): Promise<void> {
    this.wantRunning = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set({ status: "error", reason: "CAMERA_NOT_FOUND", message: "The camera API is unavailable. Open the app over https or on localhost / 127.0.0.1." });
      return;
    }
    this.set({ status: "starting" });
    try {
      this.stopTracks();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      const track = this.stream.getVideoTracks()[0];
      track.addEventListener("ended", () =>
        this.set({ status: "error", reason: "CAMERA_DISCONNECTED", message: "Camera was disconnected or stopped." }),
      );
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.video.videoWidth) await new Promise((r) => this.video.addEventListener("loadedmetadata", r, { once: true }));
      this.set({ status: "live", label: track.label, width: this.video.videoWidth, height: this.video.videoHeight });
    } catch (err) {
      const { reason, message } = cameraError((err as DOMException)?.name, (err as Error)?.message ?? String(err));
      this.set({ status: "error", reason, message });
    }
  }

  stop(): void {
    this.wantRunning = false;
    this.stopTracks();
    this.set({ status: "idle" });
  }

  private stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
