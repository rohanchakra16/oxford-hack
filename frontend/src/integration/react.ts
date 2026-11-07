/** React bindings for a ReviewClient. Owner: Person 5. */
import { useEffect, useSyncExternalStore } from 'react';
import type { ReviewClient, ReviewClientSnapshot } from './types';

/** Subscribe a component to the client's snapshot. */
export function useReviewSnapshot(client: ReviewClient): ReviewClientSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/** Connect on mount, dispose on unmount. Create the client once (e.g. with useState(() => createReviewClient())). */
export function useReviewConnection(client: ReviewClient): void {
  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);
}
