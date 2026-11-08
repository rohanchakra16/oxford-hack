# Questions (browser side)

Owner: @aryanmorarji (Person 4). Issue: #72. Full design, setup, privacy notes and handoffs:
[`inference/QUESTION_GENERATION.md`](../../../inference/QUESTION_GENERATION.md).

Status: **implemented and unit-tested; not mounted in `product/App.tsx`** (product composition is
@rohanchakra16's redesign).

| File | Purpose |
|---|---|
| `excerpt.ts` | `excerptForBookmark(sentences, bookmark)`: whole sentences for the bookmark's evidence interval plus 20 s lead, nothing later, max 3000 chars. |
| `client.ts` | `requestQuestion(bookmark, excerpt, { backendUrl, launchToken })` → `ready` / `insufficient_context` / `unavailable` (never throws except on abort). |
| `store.ts` | Per-bookmark entries: `generating` → `ready` / `insufficient_context` / `unavailable` / `no_transcript`. One request per bookmark, explicit retry, lecture change clears and discards late replies. |
| `useBookmarkQuestions.ts` | React hook wiring the above to the bookmark list and transcript. |
| `BookmarkQuestion.tsx` | Minimal unstyled view; suggested answer hidden until asked. |

The browser never talks to OpenRouter and never holds the key; it calls the local backend's
`POST /api/v0/questions` with the launch token, like the attention endpoints.

Keep `enabled: false` for the synthetic adapter and until the viewer agrees that transcript
excerpts are sent to OpenRouter.
