export * from "./types";
export { GazeEngine, MODEL_NAME, MODULE_VERSION } from "./engine";
export type { GazeEngineOptions, CalibrationUI, FrameDebug } from "./engine";
export { fitCalibration, predictScreen, DEFAULT_TARGETS } from "./calibration";
export type { CalibrationModel, CalibrationPoint } from "./calibration";
export { classifyRegion, signedDistanceToRect } from "./region";
export { summarise } from "./summary";
export { elementScreenRect, viewportToScreen, screenToViewport } from "./geometry";
