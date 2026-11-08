# Questions (browser side)

Owner: @aryanmorarji (Person 4). Issue: #72. Full design, setup, privacy notes and handoffs:
[`inference/QUESTION_GENERATION.md`](../../../inference/QUESTION_GENERATION.md).

Status: integrated as an explicit per-passage request in saved moments on this branch.
Product composition and styling remain @rohanchakra16's responsibility.

| File | Purpose |
|---|---|
| `excerpt.ts` | Whole sentences around the evidence interval plus 20 s lead. Soft target 3000 characters, hard limit 3500; prioritises the interval end and drops earlier whole sentences when needed. A sentence crossing the evidence end is completed. A single oversized target sentence is refused rather than truncated. |
| `client.ts` | `requestQuestion(bookmark, excerpt, { backendUrl, launchToken })` → `ready` / `insufficient_context` / `unavailable` (never throws except on abort). |
| `store.ts` | Per-bookmark entries: `generating` → `ready` / `insufficient_context` / `unavailable` / `no_transcript`. One request per bookmark, explicit retry, lecture change clears and discards late replies. |
| `useBookmarkQuestions.ts` | React hook wiring the above to the bookmark list and transcript. |
| `BookmarkQuestion.tsx` | Minimal unstyled view; suggested answer hidden until asked. |

The browser never talks to OpenRouter and never holds the key; it calls the local backend's
`POST /api/v0/questions` with the launch token, like the attention endpoints.

Keep `enabled: false` for the synthetic adapter and until the viewer agrees that transcript
excerpts are sent to OpenRouter.
