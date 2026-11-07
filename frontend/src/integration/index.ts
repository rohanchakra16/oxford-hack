/**
 * PUBLIC ENTRY POINT for product code (PROPOSED). Import only from here:
 *   import { createReviewClient, useReviewSnapshot } from '../integration';
 * Owner: Person 5. See docs/frontend-integration.md.
 */
import { LiveReviewClient, type LiveClientOptions } from './live/client';
import { captureLaunchTokenFromUrl, getLaunchToken } from './live/pairing';
import { SyntheticReviewClient, type SyntheticClientOptions } from './synthetic/client';
import type { AdapterKind, ReviewClient } from './types';

export type * from './types';
export { attachMediaElement } from './attachMediaElement';
export { useReviewConnection, useReviewSnapshot } from './react';
export { ManualTimers, realTimers, type Timers } from './timers';
export { DEFAULT_SCENARIO, SyntheticReviewClient, type SyntheticScenario } from './synthetic/client';
export { LiveReviewClient } from './live/client';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8765';

/**
 * Which adapter to use: `?adapter=synthetic|live` in the URL, else VITE_REVIEW_ADAPTER, else live.
 */
export function selectedAdapter(): AdapterKind {
  const fromUrl = new URLSearchParams(window.location.search).get('adapter');
  const value = fromUrl ?? (import.meta.env.VITE_REVIEW_ADAPTER as string | undefined) ?? 'live';
  return value === 'synthetic' ? 'synthetic' : 'live';
}

export function createReviewClient(
  kind: AdapterKind = selectedAdapter(),
  options: { live?: Partial<LiveClientOptions>; synthetic?: SyntheticClientOptions } = {},
): ReviewClient {
  if (kind === 'synthetic') return new SyntheticReviewClient(options.synthetic);
  captureLaunchTokenFromUrl();
  return new LiveReviewClient({
    backendUrl: (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? DEFAULT_BACKEND_URL,
    getLaunchToken,
    ...options.live,
  });
}
