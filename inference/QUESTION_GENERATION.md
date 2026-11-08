# Bookmark-linked recall questions (OpenRouter, demo)

Owner: @aryanmorarji (Person 4). Issue: #72. Branch: `72-bookmark-questions`.

Status: **implemented and unit-tested on this branch; not yet mounted in the live backend or shown
in the product UI.** Both need short handoffs (below). Not a validated learning tool: questions are
AI-generated study prompts. Nothing is graded.

## What it does

When a review bookmark appears, the app writes one short recall question about the lecture content
that bookmark covers, with a suggested answer and a supporting quote from the transcript. The
student can open it later from the bookmark (timeline/moments placement is a later UI decision).

```text
Bookmark arrives in the browser (ReviewClient snapshot)
  -> browser picks the transcript excerpt for the bookmark's evidence interval    frontend/src/questions/excerpt.ts
  -> entry = "generating"; POST /api/v0/questions to the local backend           frontend/src/questions/client.ts
       -> backend checks Origin + launch token, cache, rate-limit block           inference/question_generation.py
       -> OpenRouter chat completions (only the excerpt text is sent)
       -> validate JSON, check the quote is in the excerpt, cache
  -> entry = "ready" | "insufficient_context" | "unavailable" (retryable)        frontend/src/questions/store.ts
```

Why this split:

- `payloads.py` already says `TranscriptContext` is **filled by the browser (P4)**; the backend has no
  transcript. So the browser chooses the excerpt and the backend only holds the key.
- The key must never reach the browser, so the model call is on the backend.
- Generation is background work. Bookmarks, playback, replay and feedback never wait for it, and a
  failure only changes the question entry.

No new dependencies (stdlib `urllib` in Python; `fetch` in the browser). No wire-schema change:
`/api/v0/questions` is prototype-local, like the attention endpoints.

## Set up (demo laptop)

1. Create an OpenRouter account and a key at https://openrouter.ai/keys.
2. Put it in the backend's environment only. Never in frontend code, `.env` files committed to Git,
   screenshots or the board:

   ```bash
   export OPENROUTER_API_KEY=...            # required
   export OPENROUTER_MODEL=openrouter/free  # optional; default openrouter/free
   ```

3. Check it works with one real request (the first milestone):

   ```bash
   cd platform
   PYTHONPATH="..:src" uv run python -m inference.question_generation
   PYTHONPATH="..:src" uv run python -m inference.question_generation --text "your own excerpt"
   ```

   It prints the JSON result and how long it took. Each run uses one request from the free daily
   allowance.

4. Start the backend as usual (after the mount handoff below).

### Model choice

`openrouter/free` picks an available free model per request and only routes to models that support
the request's structured-output format. Good for getting started; question style can vary between
requests. For the demo, test a few `:free` models on your lecture and pin the best with
`OPENROUTER_MODEL`. The result reports the model that actually answered.

### Free-tier limits

OpenRouter free models are limited per minute and per day, and failed attempts count. This module:

- sends one request at a time;
- caches by model + prompt version + excerpt, so the same excerpt never costs a second request;
- skips the request entirely for excerpts under 12 words (`insufficient_context`);
- on HTTP 429, blocks further calls until `Retry-After` (60 s if absent) instead of retrying, and
  the UI shows "Free question limit reached" with a manual "Try again".

The cache is in memory: restarting the backend clears it (as with bookmarks). For the presentation,
generate the questions for the demo lecture once beforehand while the backend stays running.

## API

`POST /api/v0/questions` — headers `origin` (allowed list) and `x-launch-token`.

```json
{ "bookmarkId": "b1", "videoId": "v1", "startMediaS": 30, "endMediaS": 60, "text": "excerpt, max 4000 chars" }
```

| Status | Body |
|---|---|
| 200 | `{ status: "ready", question, suggestedAnswer, supportingQuote, quoteVerified, model, promptVersion, cached, generatedAtUnixS, bookmarkId, videoId }` |
| 200 | `{ status: "insufficient_context", ... }` (empty question fields) |
| 401 / 403 | `not_authenticated` / `origin_rejected` |
| 429 | `{ error: "rate_limited", message, retryAfterS }` plus `Retry-After` header |
| 502 | `provider_error` or `invalid_output` |
| 503 | `not_configured` (no key, or key rejected) |
| 504 | `timeout` (25 s) |

`GET /api/v0/questions/status` returns `{ configured, model, promptVersion }`.

`quoteVerified` means the quote appears word for word (ignoring case and punctuation) in the excerpt
sent. It is a grounding hint, not a check that the question or answer is correct. A paraphrased
quote is kept but labelled "Not found word-for-word in the transcript".

## Prompt

Version `recall-q-v1` (`SYSTEM_PROMPT` in `question_generation.py`): one short recall question about
the central teaching point, answerable from the excerpt only; answer supported by the excerpt; quote
copied exactly; excerpt treated as data, not instructions; no mention of attention/EEG/missing
content; `insufficient_context` when there is nothing specific to ask. Output is constrained with
`response_format: json_schema` and `provider.require_parameters: true`; a fenced or wrapped JSON
reply is also accepted. Change `PROMPT_VERSION` whenever the prompt changes so cached answers from
the old prompt are not reused.

## Excerpt selection (browser)

`excerptForBookmark(sentences, bookmark)`:

- interval = `evidenceMedia` (the content the bookmark covers), not the arrival time; manual bookmarks
  use the 20 s before the mark;
- whole transcript sentences overlapping `[start − 20 s, end]`;
- nothing that starts after the interval, so the question cannot reveal content not yet reached;
- at most 3000 characters, dropping the earliest context first;
- no overlapping speech → `insufficient_context`, no request.

## Privacy

Only the excerpt text, bookmark id and video id reach the local backend, and only the excerpt text is
sent to OpenRouter (an external service). No EEG, gaze, webcam, attention score or student answer is
sent. Before this was added the transcript never left the browser; this feature changes that, so:

- `useBookmarkQuestions({ enabled })` must be false unless the viewer has agreed to send excerpts
  to OpenRouter, and always false for the synthetic adapter;
- use only lecture material the team is allowed to send to a third party.

## Handoffs needed

### @rohanchakra16 — mount the route (platform CLI, 2 lines)

In `platform/src/oxford_hack/cli.py`, after `app = create_app(config, hub_factory)`:

```python
from inference.question_generation import register_question_routes  # type: ignore[import-not-found,unused-ignore]

register_question_routes(app, launch_token=config.launch_token, allowed_origins=config.allowed_origins)
```

Same lazy-import pattern `cli.py` already uses for `inference.adapter`. Checked locally against the real `create_app` (CORS preflight for `x-launch-token` passes, POST
returns the question). Without `OPENROUTER_API_KEY` the route answers 503 `not_configured` and
nothing else changes. If you prefer it inside `create_app`, the call is the same.

### @rohanchakra16 / @Betty505 — show it in the redesign

```tsx
import { BookmarkQuestion, useBookmarkQuestions } from '../questions';

const questions = useBookmarkQuestions({
  bookmarks: activeBookmarks,
  sentences: transcript?.sentences ?? null,
  videoId: lecture?.videoId ?? null,
  enabled: client.kind === 'live' && questionsConsent,
});

// inside each bookmark / moment card:
<BookmarkQuestion entry={questions.get(bookmark.bookmarkId)} onRetry={() => questions.retry(bookmark)} />
```

`BookmarkQuestion` is deliberately unstyled (class `bookmark-question`, test ids
`bookmark-question`, `bookmark-question-text`, `bookmark-question-answer`, `bookmark-question-retry`,
`data-status`). Placement, styling and the consent control are yours.

### @Seikaro — scheduler integration (optional)

`scheduler_provider(generator)` returns a `QuestionProvider` for `LecturePrototype(question_provider=...)`
and falls back to `placeholder_question` on any failure. Suggested improvements, for you to decide:

1. `QuestionScheduler.poll()` calls the provider synchronously, so a real model blocks `poll` for up
   to the timeout. Prefetch at `queue()` time (generate in a worker when the segment is queued) and
   keep `poll()` for presentation pacing only.
2. `QuestionRequest.placeholder` is `Literal[True]`; real generated text needs `placeholder: false`
   plus provenance (model, prompt version, quote).
3. The 8-excerpt cap counts captions, not text; a character cap like the browser's is more predictable.

## Tests

```bash
cd platform && PYTHONPATH="..:src" uv run pytest -p no:warnings ../inference/tests/test_question_generation.py
cd frontend && npx vitest run src/questions
```

Covered: request shape (key only in the header, only the excerpt in the body), cache, short-excerpt
skip, insufficient context, invalid/fenced output, quote check, missing key, 429 block and recovery,
scheduler fallback, route auth and error mapping; excerpt interval/lead/cap/no-future rule, client
error mapping, store de-duplication, retry, late-response discard and lecture filtering.

Not tested: a real OpenRouter call in CI (needs a key and uses quota), question quality on real
lectures, and the UI in a browser (not mounted yet).
