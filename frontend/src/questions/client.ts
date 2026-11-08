/**
 * Ask the local backend for a bookmark's question. Owner: Person 4 (@aryanmorarji). Issue #72.
 *
 * The browser never talks to OpenRouter and never sees the API key: the backend route
 * POST /api/v0/questions (inference/question_generation.py) does. Same access rule as the
 * attention endpoints: allowed Origin plus the launch token from pairing.
 */
import type { TranscriptContext } from '../integration';

export interface GeneratedQuestion {
  question: string;
  suggestedAnswer: string;
  supportingQuote: string;
  /** The quote appears verbatim in the excerpt that was sent. Not a correctness check. */
  quoteVerified: boolean;
  model: string;
  promptVersion: string;
  /** Served from the backend cache rather than a new model request. */
  cached: boolean;
}

export type UnavailableCode =
  | 'not_configured' | 'rate_limited' | 'timeout' | 'provider_error' | 'invalid_output'
  | 'not_paired' | 'network' | 'backend_error';

export type QuestionOutcome =
  | { status: 'ready'; result: GeneratedQuestion }
  | { status: 'insufficient_context' }
  | { status: 'unavailable'; code: UnavailableCode; message: string; retryAfterS: number | null };

export interface RequestOptions {
  backendUrl: string;
  launchToken: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured: 'Question generation is off: no OpenRouter key on the backend.',
  rate_limited: 'Free question limit reached. Try again later.',
  timeout: 'The question service took too long.',
  provider_error: 'The question service is unavailable.',
  invalid_output: 'The model did not return a usable question.',
  not_paired: 'Pair with the backend to generate questions.',
  network: 'Cannot reach the local backend.',
  backend_error: 'The backend could not generate a question.',
};

export async function requestQuestion(
  bookmark: { bookmarkId: string; videoId: string },
  excerpt: TranscriptContext,
  { backendUrl, launchToken, signal, fetchImpl = fetch }: RequestOptions,
): Promise<QuestionOutcome> {
  const unavailable = (code: UnavailableCode, message?: string, retryAfterS: number | null = null): QuestionOutcome =>
    ({ status: 'unavailable', code, message: message || MESSAGES[code], retryAfterS });
  if (!launchToken) return unavailable('not_paired');
  let response: Response;
  try {
    response = await fetchImpl(`${backendUrl}/api/v0/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-launch-token': launchToken },
      body: JSON.stringify({ bookmarkId: bookmark.bookmarkId, videoId: bookmark.videoId, ...excerpt }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailable('network');
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* handled below */ }
  if (!response.ok) {
    const code = typeof body.error === 'string' && body.error in MESSAGES ? (body.error as UnavailableCode) : 'backend_error';
    const retry = typeof body.retryAfterS === 'number' ? body.retryAfterS : null;
    // Never surface raw backend text other than the backend's own safe message.
    return unavailable(code, typeof body.message === 'string' ? body.message : undefined, retry);
  }
  if (body.status === 'insufficient_context') return { status: 'insufficient_context' };
  if (body.status !== 'ready' || typeof body.question !== 'string' || typeof body.suggestedAnswer !== 'string') {
    return unavailable('invalid_output');
  }
  return {
    status: 'ready',
    result: {
      question: body.question,
      suggestedAnswer: body.suggestedAnswer,
      supportingQuote: typeof body.supportingQuote === 'string' ? body.supportingQuote : '',
      quoteVerified: body.quoteVerified === true,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      promptVersion: typeof body.promptVersion === 'string' ? body.promptVersion : 'unknown',
      cached: body.cached === true,
    },
  };
}
