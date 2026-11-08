/**
 * Ask the local backend for a bookmark's question. Owner: Person 4 (@aryanmorarji). Issue #72.
 *
 * The browser never talks to OpenRouter and never sees the API key: the backend route
 * POST /api/v0/questions (inference/question_generation.py) does. Same access rule as the
 * attention endpoints: allowed Origin plus the launch token from pairing.
 */
import type { TranscriptContext } from '../integration';
import type { Sentence } from '../transcript';
import { bookmarkInterval, type BookmarkRange } from './excerpt';

export interface ProviderSelection { provider: 'openrouter' | 'chatgpt'; accountId?: string; model?: string }
export interface QuestionAccount { id: string; label: string; connected: boolean; planEnabled: boolean }
export interface QuestionProviderStatus {
  configured: boolean; model: string;
  chatgpt: { pending: boolean; error: string | null; accounts: QuestionAccount[] };
}

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
  /** Older excerpt-only responses can lack choices; those cannot be scored as MC. */
  choices?: string[];
  correctChoiceIndex?: number;
}

export type UnavailableCode =
  | 'not_configured' | 'rate_limited' | 'timeout' | 'provider_error' | 'invalid_output'
  | 'not_paired' | 'network' | 'backend_error';
export type ProviderErrorCode = UnavailableCode | 'not_connected' | 'plan_not_enabled' | 'context_expired';

export type QuestionOutcome =
  | { status: 'ready'; result: GeneratedQuestion }
  | { status: 'insufficient_context' }
  | { status: 'skipped_non_instructional'; reason: string }
  | { status: 'unavailable'; code: ProviderErrorCode; message: string; retryAfterS: number | null };

export interface RequestOptions {
  backendUrl: string;
  launchToken: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  selection?: ProviderSelection;
  contextId?: string;
  target?: { startS: number; endS: number };
}

const MESSAGES: Record<ProviderErrorCode, string> = {
  not_configured: 'Question generation is off: no OpenRouter key on the backend.',
  rate_limited: 'Free question limit reached. Try again later.',
  timeout: 'The question service took too long.',
  provider_error: 'The question service is unavailable.',
  invalid_output: 'The model did not return a usable question.',
  not_paired: 'Pair with the backend to generate questions.',
  network: 'Cannot reach the local backend.',
  backend_error: 'The backend could not generate a question.',
  not_connected: 'Connect your ChatGPT account first.',
  plan_not_enabled: 'Allow ChatGPT plan usage when connecting.',
  context_expired: 'The lecture context expired. Try again.',
};

export class QuestionApiError extends Error {
  constructor(public code: ProviderErrorCode, message: string, public retryAfterS: number | null = null) { super(message); }
}

export async function questionApi<T>(path: string, options: RequestOptions, body?: unknown): Promise<T> {
  if (!options.launchToken) throw new QuestionApiError('not_paired', MESSAGES.not_paired);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.backendUrl}/api/v0/questions${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-launch-token': options.launchToken },
      body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new QuestionApiError('network', MESSAGES.network);
  }
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data.error === 'string' && data.error in MESSAGES ? data.error as ProviderErrorCode : 'backend_error';
    throw new QuestionApiError(code, typeof data.message === 'string' ? data.message : MESSAGES[code], typeof data.retryAfterS === 'number' ? data.retryAfterS : null);
  }
  return data as T;
}

export async function requestQuestion(
  bookmark: { bookmarkId: string; videoId: string },
  excerpt: TranscriptContext,
  { backendUrl, launchToken, signal, fetchImpl = fetch, selection, contextId, target }: RequestOptions,
): Promise<QuestionOutcome> {
  const unavailable = (code: ProviderErrorCode, message?: string, retryAfterS: number | null = null): QuestionOutcome =>
    ({ status: 'unavailable', code, message: message || MESSAGES[code], retryAfterS });
  if (!launchToken) return unavailable('not_paired');
  let response: Response;
  try {
    response = await fetchImpl(`${backendUrl}/api/v0/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-launch-token': launchToken },
      body: JSON.stringify({ bookmarkId: bookmark.bookmarkId, videoId: bookmark.videoId, ...excerpt,
        selection, contextId, targetStartMediaS: target?.startS, targetEndMediaS: target?.endS }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailable('network');
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* handled below */ }
  if (!response.ok) {
    const code = typeof body.error === 'string' && body.error in MESSAGES ? (body.error as ProviderErrorCode) : 'backend_error';
    const retry = typeof body.retryAfterS === 'number' ? body.retryAfterS : null;
    // Never surface raw backend text other than the backend's own safe message.
    return unavailable(code, typeof body.message === 'string' ? body.message : undefined, retry);
  }
  if (body.status === 'insufficient_context') return { status: 'insufficient_context' };
  if (body.status === 'skipped_non_instructional' && typeof body.skipReason === 'string') {
    return { status: 'skipped_non_instructional', reason: body.skipReason };
  }
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
      choices: Array.isArray(body.choices) && body.choices.every((value) => typeof value === 'string') ? body.choices : undefined,
      correctChoiceIndex: typeof body.correctChoiceIndex === 'number' ? body.correctChoiceIndex : undefined,
    },
  };
}

/** One immutable outline per transcript/provider. No question or answer enters preparation. */
export function createContextQuestionRequester(options: RequestOptions) {
  let controller = new AbortController();
  const contexts = new Map<string, Promise<string>>();
  const contextFor = (bookmark: BookmarkRange, sentences: readonly Sentence[]) => {
    const original = sentences.map((s) => ({ startMediaS: s.startS, endMediaS: s.endS, text: s.text }));
    const key = JSON.stringify([bookmark.videoId, original]);
    let pending = contexts.get(key);
    if (!pending) {
      pending = questionApi<{ contextId: string }>('/context', { ...options, signal: controller.signal }, {
        videoId: bookmark.videoId, sentences: original, selection: options.selection,
      }).then((result) => result.contextId).catch((error: unknown) => { contexts.delete(key); throw error; });
      contexts.set(key, pending);
    }
    return { key, pending };
  };
  return {
    async request(bookmark: BookmarkRange, excerpt: TranscriptContext, signal: AbortSignal, sentences: readonly Sentence[]): Promise<QuestionOutcome> {
      try {
        signal.throwIfAborted();
        const { key, pending } = contextFor(bookmark, sentences);
        let contextId = await pending;
        signal.throwIfAborted();
        const request = () => requestQuestion(bookmark, excerpt, { ...options, contextId, target: bookmarkInterval(bookmark), signal });
        let result = await request();
        if (result.status === 'unavailable' && result.code === 'context_expired') {
          contexts.delete(key);
          contextId = await contextFor(bookmark, sentences).pending;
          signal.throwIfAborted();
          result = await request();
        }
        return result;
      } catch (error) {
        if (signal.aborted || controller.signal.aborted) throw error;
        const failure = error instanceof QuestionApiError ? error : new QuestionApiError('backend_error', MESSAGES.backend_error);
        return { status: 'unavailable', code: failure.code, message: failure.message, retryAfterS: failure.retryAfterS };
      }
    },
    dispose() { controller.abort(); contexts.clear(); controller = new AbortController(); },
  };
}
