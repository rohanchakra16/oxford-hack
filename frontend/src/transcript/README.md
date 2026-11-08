# Transcript

Owner: @aryanmorarji (Person 4, playback and transcript). Issue: #3. Branch: `person4/video-player`.

Status: **transcript loading, sentence view, current-sentence highlight and click-to-seek implemented
on this branch. Not merged.** Interface is **PROPOSED** until @Betty505 agrees it on the board (#1).

Lives in `frontend/src/transcript/` (see the path note in `src/player/README.md`).

## What it does

- Opens a caption file **from this device**: WebVTT (`.vtt`) or SubRip (`.srt`). It is read in the
  browser and never uploaded. Exception: if bookmark questions are enabled (#72,
  `src/questions/`), the excerpt around each bookmark is sent via the local backend to OpenRouter.
- Turns caption cues into **sentences**. Captions break wherever the captioner chose, often
  mid-sentence; replay should start at the beginning of a sentence.
- Shows the sentences with start times, highlights the one playing now, and keeps it in view
  ("Follow along" can be switched off).
- Clicking a sentence seeks the player to its start.
- Handles missing and bad data: no transcript, wrong file type, empty, too large (>10 MB),
  unreadable, no usable captions, individual bad cues (skipped and listed), out-of-order cues
  (sorted), and a transcript that runs well past the end of the video ("may be for a different
  lecture"). A failed load keeps the previous transcript.
- Provides the replay-destination helper the review UI needs: `replayStartFor(...)`.

## Interface (PROPOSED)

```tsx
import { TranscriptPanel, replayStartFor, toTranscriptContext, type Transcript } from '../transcript';

const [transcript, setTranscript] = useState<Transcript | null>(null);
<TranscriptPanel key={videoId} player={player} onTranscriptChange={setTranscript} />
```

| Export | Meaning |
|---|---|
| `TranscriptPanel({ player, onTranscriptChange })` | The panel. `player` is the `PlayerHandle` (may be null while mounting). Give it `key={videoId}` so a new lecture clears the old transcript. |
| `Transcript` | `{ fileName, format, cues, sentences, warnings }` |
| `Sentence` | `{ index, startS, endS, text, cueIndices }` |
| `sentenceIndexAt(sentences, timeS)` | Index of the sentence playing at `timeS`: the last one that has started, so it stays current during a pause in speech. -1 before the first. Binary search. |
| `replayStartFor(sentences, timeS, sentencesEarlier = 0)` | Start of the sentence containing `timeS`, moved back `sentencesEarlier` whole sentences ("move earlier"). Before any speech, or with no sentences, returns `timeS`. |
| `toTranscriptContext(sentence)` | The shared contract's `TranscriptContext` `{ startMediaS, endMediaS, text }`. |
| `loadTranscriptFile(file)`, `transcriptFromText(text, name)` | Load without the panel. Return `{ ok: true, transcript }` or `{ ok: false, message }`. |
| `parseTranscript`, `buildSentences` | Lower-level parsing and splitting. |

### Proposed replay rule (for @Betty505)

For a suggestion at `ReviewBookmark.suggestedMediaS`:
replay from `replayStartFor(transcript.sentences, suggestedMediaS, n)`, where `n` is the number of
times the student pressed "Move earlier" (UI state keyed by `bookmarkId`). Without a transcript, use
`suggestedMediaS`. The dev harness shows this working.

### Units and timing

- **All times are media seconds**, the same clock as `PlayerHandle` and `HTMLMediaElement.currentTime`.
- Captions are timed per cue, not per word. When a sentence ends inside a cue, its time is estimated
  from its character position in the cue, so a sentence start can be off by up to about one cue
  (typically 2–5 s), so a replay can start slightly early or late by that much.
- Captions without punctuation (many auto-generated ones) are split at pauses of 2 s or more
  between cues, and at the next cue boundary after 20 s.

### Sentence-splitting rules

Sentence ends are `.`, `?`, `!`, `…` (optionally followed by closing quotes or brackets), followed by
a space or the end. Not a sentence end: common abbreviations (`e.g.`, `i.e.`, `etc.`, `vs.`, `Dr.`,
`Prof.`, `Fig.`, `Eq.`, …) and decimals (`3.5`). Initials like "J. Smith" **do** split.

Auto-generated captions often repeat the previous line at the top of the next cue; repeated leading
lines are removed. Side effect: if a speaker says the identical line twice in consecutive cues, the
second is dropped.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Public exports. Import only from here. |
| `TranscriptPanel.tsx` | React panel: open, states, sentence list, highlight, follow, click-to-seek. Re-renders only when the current sentence changes. |
| `parse.ts` | WebVTT/SRT parser: timestamps, NOTE/STYLE/REGION, cue settings, tags, entities, BOM/CRLF, rolling duplicates. |
| `sentences.ts` | Cues → sentences; `sentenceIndexAt`, `replayStartFor`, `toTranscriptContext`. |
| `load.ts` | File checks, loading, duration-mismatch warning. |
| `transcript.css` | Transcript-only styles, prefixed `tp-`. |
| `*.test.ts` | Unit tests. |

## Run

The transcript is in the player dev harness, next to the video:

```bash
cd frontend
npm run dev
```

<http://127.0.0.1:5173/src/player/dev/index.html?adapter=synthetic>

Open a lecture video, then its `.vtt` or `.srt`. Never commit lecture media or transcripts.

## Test

```bash
cd frontend
npx vitest run src/transcript
npm test && npm run typecheck && npm run lint
```

### Verified (2026-11-07, Node 22.23, Chromium, synthetic adapter)

- `npm test`: 104 passed (20 transcript, 28 player, 56 existing). `typecheck`, `lint`, `build`: clean.
- Manual, in the dev harness with a generated 2-minute video and a matching 24-cue `.vtt`:
  a non-caption file shows an error; a transcript opened before the video is listed with seeking
  disabled; opening a video clears it; captions that split a sentence are merged ("We will start
  with the resting potential, which is about minus seventy millivolts.") and a cue with two
  sentences is split ("Why does this matter?" 0:25 / "Because timing is everything." 0:27); clicking
  a sentence seeks to its start (27.16 s); the highlight follows playback; a transcript that runs to
  605 s on a 120 s video shows the mismatch warning; for a synthetic suggestion at 0:46 the replay
  starts at 0:45 (sentence start), and "Move earlier" moves it to 0:40.

Not verified: real lecture caption files (Panopto, YouTube, Teams exports), very long transcripts
(> 2 h) for scrolling performance, non-English text, React component tests (no DOM test library).

## Handoffs

- @Betty505: the replay rule above, and whether the review UI should show `toTranscriptContext`
  text on each suggestion.
- @rohanchakra16: `TranscriptContext` is filled by the browser from this module; nothing is sent
  to the backend yet.
