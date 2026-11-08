/**
 * Public entry point for the player (Person 4, @aryanmorarji). Other code imports only from here.
 * PROPOSED interface: agree changes with @Betty505 on the board (#1) before depending on them.
 */
export { LecturePlayer, type LecturePlayerProps, type LoadedLecture, type LoadState, type PlayerHandle, type PlayerViewMode } from './LecturePlayer';
export { MAX_RATE, MIN_RATE, type PlaybackStatus, type ReplayRange } from './controller';
export { formatMediaTime } from './localMedia';
