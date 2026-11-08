# Recall questions and lecture context (#72)

The local demo offers two explicit providers in **Review moments → Recall questions**:

- **OpenRouter / free models** uses the existing backend `OPENROUTER_API_KEY` and optional
  `OPENROUTER_MODEL` (default `openrouter/free`). Free models are not necessarily open-source.
- **My ChatGPT Plus / Pro connection** uses supported Sign in with ChatGPT and account-specific
  models. It consumes the connected account's Work/Codex plan allowance. It does not use a
  ChatGPT password, borrow Codex's credentials, or require an OpenAI API key.

Questions remain optional, requested from saved moments, and do not control playback.
Bookmark summaries and AI answer grading are deferred. Typed answers and multiple-choice selections
remain in browser memory; neither the backend nor a provider receives student responses.

## Demo setup

1. Run the normal repository setup (`npm run setup`) so the platform environment includes
   `PyJWT[crypto]` for signed identity-token validation. Start the normal backend/frontend and
   pair the browser with the backend's launch-token link.
2. Load a lecture and transcript. In Recall questions, choose a provider.
3. For OpenRouter, configure its key in the backend environment (never the frontend). A missing
   key disables this option and leaves ChatGPT selectable.
4. For ChatGPT, press **Continue with ChatGPT**, sign in on OpenAI's page, and approve plan usage.
   Back in ReMind, choose the connected account and an available model. Multiple registrations
   can be kept separate; reconnecting uses that registration's issued client ID and stable host ID.
5. Approve the transcript-processing checkbox. This permits the selected external provider to
   analyse the complete transcript once, then receive the fixed overview and relevant passages
   when a question is requested. No transcript is uploaded merely by loading it or connecting.
6. Choose **Text answer — self-check** or **Four choices — automatically marked**. Press **Start quiz
   for N saved moments**, or use **Test your recall** on one moment. Submit each answer; typed
   responses require an explicit self-check after comparing with the suggested answer.
7. Accuracy appears after every answerable question in that quiz has been answered. Typed scores
   are labeled **Self-assessed accuracy**; choice scores use the generated answer key.

Provider, model or transcript changes require fresh transcript consent and clear question results.
There is no automatic fallback to another provider or billing path. Use **Manage ChatGPT usage**
to review plan limits. Disconnect stops local use and attempts remote session revocation; if
revocation cannot be confirmed, the UI directs the user to disconnect ReMind in ChatGPT settings.

**Token storage for this demo:** access, refresh and ID tokens stay in backend memory, outside
browser storage and logs. Restarting the backend requires sign-in again. Only the nonsecret host
ID and verified account/client registration metadata persist in ignored
`.local/chatgpt/registrations.json`. No secrets are written into the repository.

## Original-transcript context, not a rolling conversation

On the first requested question for a transcript/provider/model:

1. The browser posts the original timestamped transcript sentences to the local context route.
2. The backend splits long transcripts at sentence boundaries into bounded original-source chunks
   (24,000 characters / 80 sentences per chunk). The model creates contiguous semantic topic blocks
   with a brief summary and purpose: teaching, break, personal, administrative or uncertain.
3. Block indexes must cover every original sentence exactly once, in order. Invalid coverage is
   rejected. Times are taken from the original transcript, including overlapping caption end times.
4. The ordered chunk summaries produce one brief global overview (up to 1,600 characters).
5. Overview, blocks and original source sentences are cached. Subsequent questions retrieve blocks
   by the bookmark's evidence interval, plus neighboring original evidence for context. The question
   still needs a supporting quote matching the local excerpt; global context cannot substitute for it.

Questions and student answers never become inputs to context preparation. The overview is not
updated after each question. The initial preparation can require multiple model requests for a long
lecture; it is not one model request per block or repeated whole-lecture analysis per bookmark.

Cache keys include transcript text and timestamps, video, model and context/prompt version. Concurrent
preparations are deduplicated. Context caches hold eight lectures per provider/model in memory;
restarting the backend clears them. The browser rebuilds an evicted context once when needed.
The request limits are 500,000 transcript characters and 10,000 sentences. An individual sentence
above the context chunk limit is rejected, never silently cut.

## Sentence and output limits

The local question excerpt has a **3,000-character soft target / 3,500 hard limit**. It grows backwards
from the end of the flagged range, with up to 20 seconds of earlier context. Whole sentences only:
adding one may cross the soft target, but not the hard limit. Earlier whole sentences are omitted
when necessary. An oversized final target sentence yields insufficient context rather than a sliced
sentence. A sentence starting in the target may finish beyond it; this is boundary completion,
not a guarantee of zero text beyond the evidence end. Manual marks look back 20 seconds.

Generated question, suggested answer, quote and four answer choices have a combined 3,000-character soft target and
3,500 hard maximum. The old 400/600/600 string slicing is removed. Oversized output or a provider
truncation signal receives at most one regeneration attempt. Only complete successful output is
cached; repeated incomplete output becomes unavailable, never a fabricated successful question.
OpenRouter requests have a larger token budget on retry. ChatGPT plan requests follow their preview
contract, which does not accept a `max_output_tokens` field, so the retry asks for a shorter response.

The supporting quote must match the local transcript after case/punctuation normalization. An unmatched
quote is rejected. A matching quote is evidence of source overlap, not proof of educational correctness.

## Relevance and intentional skips

Every question prompt receives the fixed global overview, timestamp-matched teaching blocks,
original local target and neighboring evidence. The model can return `skipped_non_instructional`
with a reason for breaks, logistics or unrelated personal digressions. The card explains the skip;
the bookmark and replay remain available. Simple explanations, revision and anecdotes that teach
relevant concepts remain eligible. Uncertain relevance returns `insufficient_context` instead of
asserting that the passage is irrelevant. These judgments require real-lecture quality evaluation.

## Answers and fixed quiz sessions (#83)

Every ready response supplies four distinct choices and a zero-based `correctChoiceIndex`. The
question prompt asks for one unambiguously correct answer and three plausible, parallel distractors
without trick wording or all/none-of-the-above options. Backend validation rejects missing/duplicate
choices and invalid indexes. The prompt version is `recall-q-v3-quiz`; old cached output is not reused.
Educational correctness and distractor ambiguity still require lecture-specific review.

- Text mode supplies a 2,000-character textbox. Submit to reveal the reference, then choose **I got
  it right** or **I need to review**. No string matching or AI grading is presented as correctness.
- Choice mode shuffles display positions once per question/quiz, retaining the canonical answer key.
  Exactly one selection is submitted and locked; feedback reveals the correct choice and explanation.
- A batch snapshots the current non-dismissed saved moments. Later bookmarks do not enter that
  batch. Individual requests can start a one-question session. Existing active-batch questions remain
  answerable even if their moment is subsequently dismissed from the review view.
- Progress waits for generation to settle and all ready questions to be answered/self-checked.
  Skipped, insufficient-context and unavailable items are counted separately and excluded from
  accuracy. A batch with zero answerable questions never reports 0% or 100%.
- Provider/model/transcript/consent changes invalidate the quiz. Starting a new quiz clears all
  responses and reshuffles choices. Answer fingerprints prevent stale answers from scoring a
  regenerated question. Attempts are local and session-only; reloading clears them.

`frontend/src/questions/quiz.ts` computes scoring, `useRecallQuiz.ts` owns the fixed batch,
`QuestionAnswer.tsx` renders accessible answer forms and `RecallQuizControls.tsx` presents progress
and the final score. No answer-marking API endpoint or student-data upload was added.

## Local HTTP routes

Every route below requires an allowed browser Origin and the backend `x-launch-token`.
No OAuth access/refresh/ID tokens are returned to the frontend.

| Route | Purpose |
|---|---|
| `GET /api/v0/questions/status` | OpenRouter readiness and safe ChatGPT account/connection metadata |
| `POST /api/v0/questions/chatgpt/connect` | `{ accountId?: string }` → OpenAI authorization URL |
| `GET /api/v0/questions/chatgpt/models?accountId=...` | Current account's visible model slugs and labels |
| `POST /api/v0/questions/chatgpt/disconnect` | Clear account session and attempt remote revocation |
| `POST /api/v0/questions/context` | Original sentences + video + selected provider/account/model → cached context ID |
| `POST /api/v0/questions` | Bookmark excerpt + evidence range + context ID + selection → question/skip/outcome |

Selection is `{ provider: "openrouter" }` or
`{ provider: "chatgpt", accountId: "...", model: "account-visible-slug" }`.
Context sentences are `{ startMediaS, endMediaS, text }`. A question request retains the existing
`bookmarkId`, `videoId`, `startMediaS`, `endMediaS`, `text` fields and adds `selection`, `contextId`,
`targetStartMediaS`, `targetEndMediaS`. Ready responses additionally expose `choices` and `correctChoiceIndex`. Context IDs are scoped to the selected provider/account/model
and video. A stale or mismatched context returns 409 `context_expired`.

The legacy excerpt-only request remains supported for offline evaluation. The live browser always
prepares context after explicit consent. `scheduler_provider()` remains an optional offline adapter;
do not mount it in live scheduling, where its synchronous generation would block polling and
could duplicate the user's explicit request.

## Supported ChatGPT protocol

- Dynamic registration starts with `dynamic_agent_client`, stable `ext_agent_host_id`, fresh state,
  nonce and S256 PKCE. The callback supplies an issued client ID for code exchange.
- Callback is a temporary `127.0.0.1` listener at `/auth/callback`; state, exact redirect URI,
  token signature, issuer, audience, expiry and nonce are validated. Returning accounts must match.
- Plan permission is checked from granted scopes. Refresh is serialized per backend process and
  checks identity and current scopes. Tokens do not enter URLs or frontend storage.
- Models come from `GET https://api.openai.com/v1/models` using the selected account token.
- Inference uses the public Responses API with `store:false`, `stream:true`, developer instructions
  and explicit input. It omits unsupported temperature/output-token fields and requires
  `response.completed`; failures, interruptions and quota events are not treated as success.

Official documentation: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
This integration targets the locally run demo. Paid or remotely hosted deployment needs the
appropriate Sign in with ChatGPT access approval.

## Verification

- Offline Python tests cover signature/nonce/audience validation, PKCE/issued clients, denied scopes,
  serialized refresh, streaming completion, provider isolation, context cache/coverage/retrieval,
  skip outcomes, whole-sentence input limits and complete output/regeneration limits.
- Frontend tests cover selected-provider requests, context sharing/expiration, skipped entries,
  missing pairing, retry and late-response discard.
- Chromium tests use synthetic provider responses to exercise real components/hooks in StrictMode:
  consent, provider/model choice, answer reveal, cache reuse, preserved bookmarks, failures and stale
  responses. Run `node frontend/node_modules/@playwright/test/cli.js test --config frontend/e2e/questions.config.ts`.
  These tests also run under the normal infrastructure browser suite.
- A real user must complete ChatGPT authorization and verify model access on the demo machine.
  No real account or lecture upload is used by automated tests. Educational quality is not validated.
