/**
 * Launch-token pairing. The backend prints a link like http://127.0.0.1:5173/#pair=<token>.
 * The token is read from the URL fragment (never sent to any server by the browser), kept in
 * sessionStorage for this tab only, and removed from the address bar. Owner: Person 5.
 */
const KEY = 'oxford-hack.launch-token';

export function captureLaunchTokenFromUrl(loc: Location = window.location, hist: History = window.history): void {
  const match = /(?:^#|&)pair=([A-Za-z0-9_-]{16,256})/.exec(loc.hash);
  if (!match) return;
  try {
    sessionStorage.setItem(KEY, match[1]!);
  } catch {
    /* storage unavailable: token lives only for this page load */
    memoryToken = match[1]!;
  }
  hist.replaceState(null, '', loc.pathname + loc.search);
}

let memoryToken: string | null = null;

export function getLaunchToken(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function forgetLaunchToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
