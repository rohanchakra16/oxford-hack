/**
 * Public entry point for the attention timeline UI (#55). Owner: Person 4 (@aryanmorarji).
 * Composition (App.tsx) and data delivery belong to @rohanchakra16; see README.md for mount points.
 */
export { AttentionTimelineStore, latestSeries, lowRegions, timelineStats, toAttentionScore, freezeSnapshot, STORAGE_PREFIX, type KeyValueStorage, type StoreOptions } from './store';
export { observationFromEvaluation, markerFromBookmark, type BookmarkLike, type EvaluationLike, type TickPlayback } from './adapters';
export { useTimeline, useRefreshedTimeline, useAttentionLecture, type LecturePlayback } from './hooks';
export { AttentionGraph, type AttentionGraphProps, type SeekTarget } from './AttentionGraph';
export { AttentionSummary, type AttentionSummaryProps } from './AttentionSummary';
export { AttentionInfoIndicator, type AttentionInfoIndicatorProps } from './AttentionInfoIndicator';
export { AttentionDemoPanel } from './AttentionDemoPanel';
export { AttentionDemo, DEMO_PROVENANCE, type DemoPlayback } from './demo';
export type * from './types';
