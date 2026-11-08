/** M is overlaid with a subtle inverted W; accessible name remains legible ReMind. */
export function Wordmark() {
  return <span className="remind-wordmark" aria-label="ReMind"><span aria-hidden="true">Re</span><svg aria-hidden="true" viewBox="0 0 38 36" width="34" height="34"><path d="M3 31V5l16 17L35 5v26" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/><path d="M3 5l8 26 8-10 8 10 8-26" fill="none" stroke="#f69238" strokeWidth="2" strokeLinejoin="round" opacity=".8"/></svg><span aria-hidden="true">ind</span></span>;
}
