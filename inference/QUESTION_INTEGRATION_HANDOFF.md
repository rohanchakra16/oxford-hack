# Recall-question handoff (#72)

Current integration is on `72-question-context`, based on current main plus Aryan's #74 feature.
It includes the sentence/output fixes, provider selection, supported ChatGPT Plus/Pro sign-in,
fixed original-transcript context, local topic retrieval and intentional question skips.

Product composition changes are minimal: mount the provider controls, gate request buttons on
consent/readiness and correct the external-processing disclosure. Existing experimental mode is
preserved. No changes to shared layout/style files, playback, inference scheduling or schemas.

Platform changes: `PyJWT[crypto]` dependency/lock for signed OAuth ID-token validation. Existing
cli.py route mount is retained. The question endpoints keep Origin + launch-token authentication.
New API details, demo setup, limits and test commands are in QUESTION_GENERATION.md.

Before a real demo: pair the browser/backend; load video + transcript; choose provider; complete
ChatGPT sign-in yourself if selected; select a model; approve transcript processing; request a
question from a saved moment. The OAuth credential session is memory-only, so backend restart
requires sign-in again. Never paste credentials into chat, logs or the board.

Still requiring human validation: real Plus authorization/model access and lecture-question quality.
Automated tests use synthetic content/provider replies and do not consume plan usage.
Bookmark summary UI is explicitly deferred.
