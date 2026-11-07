# Local-service security (Person 5)

The backend is a local companion to one browser on the same machine. It holds sensor-derived data, so:

- **Loopback only.** `oxford-backend serve` refuses a non-loopback `--host`. Requests whose `Host` header is not
  loopback are rejected (421) to defeat DNS rebinding.
- **Origin allowlist** for both the HTTP handshake and the WebSocket (`--allowed-origin`, default
  `http://localhost:5173` and `http://127.0.0.1:5173`).
- **No shared secret in frontend code.** A per-install *launch token* is generated into `.local/launch-token`
  (mode 0600, git-ignored) and shown in a pairing link `http://127.0.0.1:5173/#pair=<token>`. The fragment is never
  sent to a server; the page keeps the token in `sessionStorage` for that tab and removes it from the address bar.
  `POST /api/v0/handshake` swaps it for a short-lived, single-use *session token* bound to the page's
  `clientInstanceId`; the WebSocket's first message presents that token. Rotate with `--rotate-launch-token`.
- **Bounded input and output.** Maximum message size, validated contracts on every message, bounded outbound queue
  per connection.
- **Test hooks** (`/api/v0/test/*`) exist only with `--enable-test-hooks`, still require the launch token, and print a
  warning at startup. Never use them with real data.
- **No recordings or participant data in git.** `.gitignore` excludes `.local/`, `data/`, `recordings/`, media files
  and `.env*`. Recording a session is opt-in and writes under `.local/`.
- **Never present replay or simulation as live.** Every message carries `runKind` (`live`, `simulated`, `replay`);
  UIs must label the non-live kinds.

Not covered: a hostile process running as the same OS user can read the token file. That is outside this threat model.
