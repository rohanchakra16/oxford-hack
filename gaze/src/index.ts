export * from "./types";
export { GazeEngine, MODEL_NAME, MODULE_VERSION } from "./engine";
export type { GazeEngineOptions, CalibrationUI, FrameDebug } from "./engine";
export {
  fitCalibration,
  calibrationSigma,
  fitPursuitCalibration,
  predictScreen,
  pursuitPath,
  DEFAULT_TARGETS,
  DEFAULT_PURSUIT,
  calibrationTargets,
} from "./calibration";
export type { CalibrationModel, CalibrationPoint, CalibrationSample, CalibrationTarget, PursuitConfig } from "./calibration";
export { scoreValidation, DEFAULT_PHASES, DEFAULT_TRANSITION_MS } from "./validation";
export type { ValidationPhase, PhaseWindow, PhaseResult, ValidationResult } from "./validation";
export { classifyRegion, classifyByProbability, probabilityInside, signedDistanceToRect, DEFAULT_THRESHOLDS } from "./region";
export { summarise } from "./summary";
export { elementScreenRect, viewportToScreen, screenToViewport } from "./geometry";
export {
  toContractObservation,
  toContractCalibration,
  gazeProvenance,
  ObservationBatcher,
  CONTRACT_SCHEMA_VERSION,
} from "./contract";
export type { ContractGazeObservation, ContractGazeCalibration, ContractProvenance, RunKind } from "./contract";
export type { CalibrationStateEvent, CalibrationAttempt } from "./engine";
