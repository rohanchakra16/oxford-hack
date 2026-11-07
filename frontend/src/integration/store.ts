/**
 * The single client-side store behind every ReviewClient. Owner: Person 5.
 * Product UI reads it through getSnapshot()/subscribe(); it never writes to it directly.
 */
import type {
  CandidateRejected,
  ClockStatus,
  PlaybackEligibility,
  ReviewBookmark,
  SensorStatus,
} from '../contracts/generated/types';
import type {
  AdapterKind,
  ClientError,
  ConnectionStatus,
  ReviewClientEvent,
  ReviewClientSnapshot,
  SessionInfo,
} from './types';

const MAX_ERRORS = 50;
const MAX_REJECTIONS = 100;

export class ClientStore {
  private snap: ReviewClientSnapshot;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: ReviewClientEvent) => void>();

  constructor(kind: AdapterKind, connection: ConnectionStatus) {
    this.snap = {
      kind,
      connection,
      session: null,
      sensors: null,
      eligibility: null,
      clock: null,
      bookmarks: [],
      rejections: [],
      errors: [],
    };
  }

  get snapshot(): ReviewClientSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: (e: ReviewClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
    this.eventListeners.clear();
  }

  private update(patch: Partial<ReviewClientSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private emit(e: ReviewClientEvent): void {
    for (const l of [...this.eventListeners]) l(e);
  }

  setConnection(patch: Partial<ConnectionStatus>): void {
    this.update({ connection: { ...this.snap.connection, ...patch } });
  }

  startSession(session: SessionInfo): void {
    this.update({ session, bookmarks: [], rejections: [], sensors: null, eligibility: null });
    this.emit({ type: 'session_started', session });
  }

  /** Replace session state wholesale (resume snapshot). */
  restoreSession(session: SessionInfo, bookmarks: readonly ReviewBookmark[], sensors: SensorStatus): void {
    this.update({ session, bookmarks: sortBookmarks(dedupe(bookmarks)), sensors });
  }

  endSession(reason: string): void {
    const id = this.snap.session?.sessionId;
    this.update({ session: null, eligibility: null, sensors: null });
    if (id) this.emit({ type: 'session_ended', sessionId: id, reason });
  }

  /** Adds or replaces by bookmarkId: a retransmitted bookmark never creates a duplicate entry. */
  upsertBookmark(b: ReviewBookmark): void {
    const existing = this.snap.bookmarks.findIndex((x) => x.bookmarkId === b.bookmarkId);
    if (existing >= 0) {
      const list = [...this.snap.bookmarks];
      list[existing] = b;
      this.update({ bookmarks: sortBookmarks(list) });
      return;
    }
    this.update({ bookmarks: sortBookmarks([...this.snap.bookmarks, b]) });
    this.emit({ type: 'bookmark_added', bookmark: b });
  }

  setSensors(sensors: SensorStatus): void {
    this.update({ sensors });
  }

  setEligibility(eligibility: PlaybackEligibility): void {
    this.update({ eligibility });
  }

  setClock(clock: ClockStatus): void {
    this.update({ clock });
  }

  addRejection(r: CandidateRejected): void {
    this.update({ rejections: [...this.snap.rejections, r].slice(-MAX_REJECTIONS) });
  }

  addError(error: ClientError): void {
    this.update({ errors: [...this.snap.errors, error].slice(-MAX_ERRORS) });
    this.emit({ type: 'error', error });
  }
}

function dedupe(list: readonly ReviewBookmark[]): ReviewBookmark[] {
  return [...new Map(list.map((b) => [b.bookmarkId, b])).values()];
}

function sortBookmarks(list: ReviewBookmark[]): ReviewBookmark[] {
  return list.sort((a, b) => a.suggestedMediaS - b.suggestedMediaS || a.bookmarkId.localeCompare(b.bookmarkId));
}
