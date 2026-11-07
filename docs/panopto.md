# Panopto feasibility (Person 4, playback)

Owner: @aryanmorarji (Person 4, playback). Issue: #3. Status: **assessment only, no code**.

Oxford lectures are recorded with Panopto, which the University calls Replay. This document
answers one question: can the review companion play Panopto lectures directly instead of a
local file, and what would that cost?

**Recommendation (summary).** For the hackathon, keep **local files** (MP4 plus an optional
VTT/SRT transcript). Downloads are possible only when the course allows them, but local files
give exact telemetry and exact gaze geometry, and need no changes to the backend or the
contracts. The realistic next step after the hackathon is **the Panopto Embed API as a second
player adapter behind the same `PlayerHandle`**. It comes with known telemetry and geometry
limits (below). A browser extension is not recommended for this project.

All Panopto behaviour below comes from Panopto's and Oxford's public documentation, cited
inline. Nothing here has been tested against Oxford's Panopto site; items marked **(untested)**
need checking with a real Oxford account before anyone relies on them.

## 1. What we need from any video source

These requirements come from the agreed interfaces (`docs/frontend-integration.md`,
`docs/TIMING.md`, `frontend/src/player/README.md`):

| Need | Why | Local file (today) |
|---|---|---|
| Every media event: play, pause, seeking/seeked, waiting, ratechange, timeupdate, ended | The backend's playback segments end at every pause, seek, stall or rate change. Evidence that crosses a boundary is rejected (`crosses_boundary`) | Yes, from the `<video>` element via `attachMediaElement` |
| Media time in seconds, about 4 Hz or faster | Heartbeats; mapping evidence to media time | Yes (`timeupdate`) |
| Seek, play, pause, replay a range | Review UI replay and "Move earlier" | Yes (`PlayerHandle`) |
| The video's on-screen content rectangle | Gaze (@ShinJuKim) normalises gaze to the displayed video, excluding letterbox bars | Yes (`getVideoElement()`, `object-fit: contain`) |
| Timed transcript (VTT/SRT) | Sentence navigation, replay destination | Yes, if the student has the caption file |
| A stable `videoId` | One session per lecture | `local-` + hash of name, size and date |

## 2. Options compared

| | A. Local download (current) | B. Panopto Embed API in our app | C. Browser extension on Panopto's site |
|---|---|---|---|
| Getting the video | Student downloads the MP4. Off by default for viewers at Oxford | Streams from Panopto in an iframe after Oxford sign-in | Uses Panopto's own viewer page |
| Media events | All of them | Play, paused and ended, rate change and errors. **No seek, buffering or time-update events** | All of them, if the page's `<video>` element can be reached **(untested)** |
| Media time | Exact, about 4 Hz | Only by polling `getCurrentTime()` | Exact |
| Gaze geometry | Exact content rectangle | Only the iframe's box. The video's position inside Panopto's layout is unknown | Possible, but tied to Panopto's page layout |
| Transcript | Student-supplied file | Same as A. Students cannot fetch captions through the API (see §4) | Possibly read from the page **(untested)** |
| Backend changes | None | None for telemetry. The player calls `reportMediaEvent` itself | Yes: the backend only accepts the `localhost:5173` origin (`docs/SECURITY.md`) |
| Interface changes | None | `getVideoElement()` would need to allow "no element" (agree with @ShinJuKim) | New delivery format, packaging and permissions |
| Effort | Done | Medium: a new adapter, about 1 to 2 days plus testing | High: a new deliverable |
| Telemetry accuracy | Best | Coarser. More evidence is rejected, but none is misplaced (see §3) | Best, if it works |

## 3. Option B in detail: Panopto Embed API

The [Panopto Embed API](https://support.panopto.com/s/article/Learn-About-Panopto-Embed-API)
embeds Panopto's player in an iframe and controls it from JavaScript.

- **Identifying a video.** The player is created with `serverName` (the Panopto site) and
  `sessionId` (a GUID), loaded from `developers.panopto.com/scripts/embedapi.min.js`. The site
  must be hosted in Panopto's Cloud, and the browser must support `postMessage`.
- **Controls.** `playVideo`, `pauseVideo`, `seekTo(seconds)`, `getCurrentTime()`,
  `getDuration()`, `getPlaybackRate`/`setPlaybackRate`, `getState()` (Playing, Paused, Ended),
  and captions (`hasCaptions`, `getCaptionTracks`, `enableCaptions`). All times are in seconds,
  the same unit as our interfaces.
- **Events.** `onIframeReady`, `onReady`, `onStateChange` (Playing, Paused, Ended),
  `onPlaybackRateChange`, `onLoginShown` and `onError`. Error values include `NoAccess`,
  `PlayNotAllowed` (autoplay blocked) and `MediaPlayerError`.
- **No seek event.** The documentation lists no seek event, and a Panopto staff answer confirms
  that seeking with the progress bar raises no event; `onStateChange` only fires on play, pause
  and end ([Panopto Community, 2024](https://community.panopto.com/discussion/920/how-to-get-event-such-on-seek-javascript-embed-api)).
  No buffering or time-update events are listed either.
- **Sign-in.** If the viewer isn't signed in, the iframe shows Panopto's login page and raises
  `onLoginShown`. Oxford recordings are available "only to users with an Oxford Single Sign On"
  ([Oxford Mathematical Institute](https://www.maths.ox.ac.uk/members/teaching-staff/teaching-remotely/recording-panopto-presentations)).
  Whether Oxford SSO completes inside an iframe on `localhost` (third-party cookie rules,
  embed-domain settings) is **(untested)**.

### How it would fit our code

- **A second controller behind `PlayerHandle`.** `seek`, `play`, `pause` and `replayRange` map
  directly onto `seekTo`, `playVideo` and `pauseVideo`. Following Panopto's advice, a pause plus
  seek calls `pauseVideo()` first. The transcript panel and review UI would be unchanged.
- **Telemetry.** There is no `<video>` element, so `attachMediaElement` can't be used. The
  adapter would call `client.reportMediaEvent` with a synthesised `MediaSnapshot`, which
  `docs/frontend-integration.md` allows (one method or the other, never both):
  - `play`/`playing` and `pause` from `onStateChange`, `ended` from Ended, and `ratechange` from
    `onPlaybackRateChange`.
  - A `timeupdate` from polling `getCurrentTime()` about every 250 ms.
  - A **jump** between polls that doesn't match elapsed time × rate would be reported as
    `seeking` then `seeked`. Seeks we start ourselves are known exactly.
  - **Buffering is invisible.** A stall looks like playback whose time stops advancing. The
    adapter could report `waiting` when the polled time stalls while the state is Playing.
- **Why this is still safe.** `docs/TIMING.md` ends a segment when a heartbeat disagrees with
  the prediction by more than 0.5 s, and rejects evidence that crosses a boundary. Missed or
  late seek and stall detection therefore makes the backend **reject more candidates**, rather
  than placing a suggestion at the wrong point in the lecture. Detection quality drops; replay
  correctness does not.
- **Gaze.** We only know the iframe's rectangle. Panopto draws its own controls, and may tile
  the slides and camera streams, inside the iframe, so the video's content box is unknown. Gaze
  would either treat the whole iframe as the video (coarser), or need a fixed, documented
  Panopto layout (for example with its overlay hidden) **(untested)**. `getVideoElement()`
  would need to become `HTMLVideoElement | null` or be replaced by a rectangle getter. That is
  an interface change to agree with @ShinJuKim first.
- **videoId.** Proposed: `panopto-<sessionId>`, for example
  `panopto-5cc99c54-6d3d-40b0-ab23-ab4c016124e0` (44 characters). This matches the contract
  pattern `^[A-Za-z0-9][A-Za-z0-9_.:-]*$` (maximum 128). The same lecture opened as a local
  file gets a different `local-...` id; that is acceptable, because each id is one session.

## 4. Transcripts and captions from Panopto

- **Viewer download.** Captions can be downloaded from the Panopto viewer only if the site
  setting "Captioning - Enable Download in Viewers" is on, and only for full recordings, not
  reference copies ([Panopto: How to Download Captions](https://support.panopto.com/s/article/How-to-Download-Captions)).
  When it's on, the student saves the file and loads it into our transcript panel, as today.
- **REST API.** Panopto's REST API returns a `CaptionDownloadUrl` for a session. However, it
  uses OAuth2 API clients created through the institution's Panopto site
  ([Panopto: Learn About the API](https://support.panopto.com/s/article/api-0)), and Panopto staff
  say the caller "should be a creator for the video, or an administrator" to download captions
  that way ([Panopto Community](https://community.panopto.com/discussion/2213/can-the-panapto-api-fetch-the-thumbnails-presented-at-the-bottom-of-a-recording)).
  **Not a realistic path for a student.**
- **In the embed.** The Embed API can switch captions on in Panopto's player, but lists no
  function that returns caption text with timings, so it can't feed our sentence navigation.

## 5. Policy and privacy

- **Downloads are opt-in per course.** At Oxford, MP4 downloads are "only enabled for content
  owners (and not viewers)" by default; enabling them needs the local IT officer or academic
  administrator, and can be turned off per session or folder
  ([Oxford IT Help: Export / download Panopto content](https://help.it.ox.ac.uk/replay/exporting)).
  Option A therefore only works for courses that allow downloads.
- **No sharing.** "Students are not allowed to share or disseminate recorded lecture content"
  ([Oxford Mathematical Institute](https://www.maths.ox.ac.uk/members/teaching-staff/teaching-remotely/recording-panopto-presentations)),
  and a student who downloads a recording agrees it is for their own viewing only
  ([Oxford IT Help](https://help.it.ox.ac.uk/replay/exporting)).
- **What we do.** The local player never uploads the file: it plays from an object URL in the
  browser and sends only playback telemetry to the loopback-only backend (`docs/SECURITY.md`).
  The repo rule stands: **never commit lecture media or transcripts**. Use generated test media
  (see `frontend/e2e/README.md`).

## 6. Option C: browser extension (not recommended)

An extension running on Panopto's viewer page could reach the real `<video>` element, giving
exact telemetry and geometry with no download. But it:

- is a different deliverable: packaging, browser permissions, install steps for every user, and
  updates whenever Panopto changes its page;
- would connect to our backend from a Panopto origin, which `docs/SECURITY.md` rejects by design
  (origin allowlist), so the backend's security model would have to change (Person 5);
- depends on Panopto's internal page structure, which is undocumented and may change;
- would need checking against University IT regulations and Panopto's terms **(untested)**.

## 7. Recommendation and next steps

1. **Hackathon: Option A (local files).** It's built, tested on a real 2-hour lecture, and gives
   the best telemetry and gaze data. The demo uses a lecture whose course allows downloads, or a
   self-recorded lecture.
2. **Possible future: Option B as an adapter.** Before building it, test with a real Oxford
   account:
   - Does Oxford SSO complete inside the iframe on `localhost`?
   - Does polling `getCurrentTime()` at 250 ms give stable times?
   - How large is the jump-detection error?
   - What layout does Panopto use inside the iframe, for gaze?
3. **Interface impact of Option B:** `PlayerHandle.getVideoElement()` would need to allow "no
   element" (agree with @ShinJuKim), and Panopto ids would follow the `panopto-<sessionId>`
   scheme. No contract change is needed: `reportMediaEvent` already exists.
4. **Not planned:** Option C, and fetching captions through the REST API.
