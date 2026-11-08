# Recall-question integration — handoff (#72 / PR #74)

Owner so far: @aryanmorarji (Aryan's Perplexity). **Aryan is out of agent credits; teammates please finish the open items below.**

## What this PR now contains (pushed, not just described)

| File | Change |
|---|---|
| `platform/src/oxford_hack/cli.py` | `serve` mounts `register_question_routes(...)` right after `create_app` (same lazy-import pattern as `inference.adapter`). |
| `frontend/src/questions/useBookmarkQuestions.ts` | New `auto` option (default **false**) and `request(bookmark)`: nothing is sent unless a student asks for that passage. `retry` is a no-op when disabled. |
| `frontend/src/product/App.tsx` | Saved-moment cards get a **"Test your recall"** button (live client only) with a one-line disclosure that only that passage's transcript text goes to OpenRouter. Pressing it is the per-passage consent. Renders the existing `BookmarkQuestion` (answer hidden until "Show suggested answer"). |
| Earlier #73 commits | Generator, route, client, store, view, tests (unchanged). |

Privacy: API key stays in the backend env (`OPENROUTER_API_KEY`); browser only sends the excerpt with the launch token. No automatic transcript upload. Synthetic/demo client never shows the button.

Playback: the request is a `fetch` from the card; it never calls the player, so playback/replay are not blocked. Failures render `Question unavailable: … Try again` inside the card only.

## Checks actually run (Linux sandbox, 2026-11-08)

- `npx tsc -b` — clean. `npx eslint src/product/App.tsx src/questions` — clean.
- `npx vitest run` — 16 files, 161 tests passed.
- `PYTHONPATH="..:src" uv run pytest ../inference/tests/test_question_generation.py tests` — all passed.
- Real `oxford_hack.cli serve` without a key: `GET /api/v0/questions/status` → 200 `{"configured":false,...}`; no token → 401; CORS preflight for `x-launch-token` → 200; malformed body → 422.
- Earlier (Aryan's Windows machine, separate checkout): real OpenRouter call → `ready`, `liquid/lfm-2.5-2.6b:free`, `quoteVerified: true`, cost 0, 1.3 s. One earlier call returned `invalid_output`; **cause unconfirmed, not fixed**.

## NOT done — please pick up

1. **Browser end-to-end test** (not run): backend with `OPENROUTER_API_KEY`, pair the tab, load lecture + transcript, add a manual marker, press "Test your recall", confirm question appears and playback keeps running.
2. **Graceful failure in browser** (not run): same flow with no key → card shows "Question unavailable" + Try again, lecture keeps playing.
3. **Styling/placement** (`.bookmark-recall`, `.bookmark-question` are unstyled) — design owner's call; check against #71 redesign before merging, App.tsx will likely conflict with #71.
4. Excerpt range for product moments: `evidenceMedia` is approximated as `suggestedMediaS → endMediaS` when `endMediaS` exists, else the manual-span default. Owner of `product/` may want a better range.
5. Optional (@Seikaro): scheduler prefetch, see `inference/QUESTION_GENERATION.md`.
