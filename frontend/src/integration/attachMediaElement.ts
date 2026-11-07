/**
 * Optional convenience for Person 4: forward a <video>/<audio> element's events to a ReviewClient.
 * Person 4 may instead call client.reportMediaEvent from their own player code; do not do both.
 */
import { MEDIA_EVENTS, mediaSnapshot } from './playback/reporter';
import type { ReviewClient } from './types';

export function attachMediaElement(client: ReviewClient, el: HTMLMediaElement, isReplaying: () => boolean = () => false): () => void {
  const handlers = MEDIA_EVENTS.map((name) => {
    const fn = () => client.reportMediaEvent(name, { ...mediaSnapshot(el), replaying: isReplaying() });
    el.addEventListener(name, fn);
    return [name, fn] as const;
  });
  return () => {
    for (const [name, fn] of handlers) el.removeEventListener(name, fn);
  };
}
