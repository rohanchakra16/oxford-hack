/**
 * Public entry point for the transcript (Person 4, @aryanmorarji). Other code imports only from here.
 * PROPOSED interface: agree changes with @Betty505 on the board (#1).
 */
export { TranscriptPanel, type TranscriptPanelProps } from './TranscriptPanel';
export { durationMismatch, loadTranscriptFile, transcriptFromText, type Transcript, type TranscriptLoad } from './load';
export { TranscriptParseError, parseTranscript, type Cue, type TranscriptFormat } from './parse';
export { buildSentences, replayStartFor, sentenceIndexAt, toTranscriptContext, type Sentence } from './sentences';
