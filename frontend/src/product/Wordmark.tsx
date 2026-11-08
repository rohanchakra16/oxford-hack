import remindLoopUrl from './remind-loop.svg';

/** The approved 01A Loop mark pairs a return-arrow R with the ReMind wordmark. */
export function Wordmark() {
  return (
    <span className="remind-wordmark" role="img" aria-label="ReMind">
      <img
        className="remind-wordmark__mark"
        src={remindLoopUrl}
        width="31"
        height="34"
        alt=""
        aria-hidden="true"
      />
      <span aria-hidden="true">ReMind</span>
    </span>
  );
}
