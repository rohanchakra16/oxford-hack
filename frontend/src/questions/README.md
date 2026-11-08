# Questions (browser side)

Issue #72. The selected provider is OpenRouter/free models or a supported ChatGPT Plus/Pro connection.
Full setup and protocol: [QUESTION_GENERATION.md](../../../inference/QUESTION_GENERATION.md).

- `QuestionProviderControls.tsx` / `useQuestionProvider.ts`: explicit provider, account and model choice,
  ChatGPT browser sign-in, connection/usage controls, and transcript-processing consent.
- `useBookmarkQuestions.ts`: consent is tied to provider/model and transcript revision. Changing them
  clears results and aborts old requests. No automatic generation by default.
- `client.ts`: authenticated local-backend calls; one shared original-transcript context preparation
  per lecture/provider; relevant context ID and original target times in each question request.
- `excerpt.ts`: whole sentences, 3000 soft / 3500 hard input budget, boundary-sentence completion,
  no slicing of overlong sentences.
- `store.ts`: per-bookmark pending, ready, insufficient, unavailable, no-transcript and intentional
  nonteaching-skip states. No bookmark deletion or playback control.
- `BookmarkQuestion.tsx`: answer hidden until requested, explicit skip reason and retryable failures.

The frontend holds only the local backend launch token and nonsecret provider/account/model choices.
OpenRouter keys and ChatGPT OAuth tokens remain in the backend. Synthetic mode does not offer questions.
Bookmark summaries remain deferred.

Issue #83 adds local answers and fixed quiz batches. `QuestionAnswer.tsx` supplies typed self-check
or shuffled four-choice answers; `useRecallQuiz.ts` snapshots moments, locks submissions and resets
on scope changes; `quiz.ts` computes the final score only after all answerable questions are
complete. `RecallQuizControls.tsx` labels self-assessed scores separately and explains excluded
questions. Student responses never enter API payloads or context summaries. Reloading clears them.
