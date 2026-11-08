import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LoadedLecture, PlayerHandle } from '../player';
import type { ReviewClientSnapshot } from '../integration';
import { FocusSetup } from '../focus/FocusSetup';
import { PersonalCalibration, type usePersonalAttention } from '../focus/usePersonalAttention';
import type { useFocusReview } from '../focus/useFocusReview';
import { CheckIcon, CloseIcon } from '../ui/icons';
import './sessionSetup.css';

export function SessionSetup({ open, onClose, snapshot, lecture, player, focus, attention, devices }: {
  open: boolean;
  onClose(): void;
  snapshot: ReviewClientSnapshot;
  lecture: LoadedLecture | null;
  player: PlayerHandle | null;
  focus: ReturnType<typeof useFocusReview>;
  attention: ReturnType<typeof usePersonalAttention>;
  devices: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [calibratingCamera, setCalibratingCamera] = useState(false);
  const connected = snapshot.connection.state === 'connected';
  const profile = attention.state?.profile;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);
  const close = () => {
    // A gaze target must stay visible until its sequence finishes or is cancelled.
    if (calibratingCamera) return;
    onClose();
  };

  return <dialog ref={dialog} className="session-setup" aria-labelledby="session-setup-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="session-setup__shell">
      <header className="session-setup__header">
        <h1 id="session-setup-title">Session setup</h1>
        <button className="btn btn--icon" disabled={calibratingCamera} onClick={close} aria-label="Back to lecture" title="Back to lecture"><CloseIcon /></button>
      </header>
      <div className="session-setup__grid">
        <section className="session-setup__card" aria-labelledby="prerequisites-title">
          <h2 id="prerequisites-title">Connection</h2>
          <ol className="setup-checklist">
            <li><span className={`setup-check ${connected ? 'setup-check--ready' : ''}`} aria-hidden="true">{connected ? <CheckIcon /> : '1'}</span><div><strong>Local connection</strong><p>{connected ? 'Connected.' : snapshot.connection.detail}</p></div></li>
            <li><span className={`setup-check ${lecture ? 'setup-check--ready' : ''}`} aria-hidden="true">{lecture ? <CheckIcon /> : '2'}</span><div><strong>Your lecture</strong><p>{lecture ? lecture.fileName : 'Open a video to calibrate.'}</p>{!lecture && <button className="button button--quiet button--small" onClick={close}>Choose a lecture</button>}</div></li>
            <li><span className={`setup-check ${profile ? 'setup-check--ready' : ''}`} aria-hidden="true">{profile ? <CheckIcon /> : '3'}</span><div><strong>Personal baseline</strong><p>{profile ? 'Saved baseline loaded.' : 'Not calibrated yet.'}</p></div></li>
          </ol>
          {devices}
          <details className="setup-help">
            <summary>Device or score source unavailable?</summary>
            <p>Turn on and connect your Unicorn headset, check electrode contact, and keep the local launcher running. The Unicorn SDK and an EEG attention-score source must be installed once on this computer.</p>
            <p>Without a score source, attention stays unavailable. You can still watch and save review markers.</p>
            <a href="/diagnostics" target="_blank" rel="noreferrer">Open system diagnostics</a>
          </details>
        </section>
        <section className="session-setup__card" aria-labelledby="calibration-title">
          <h2 id="calibration-title">Calibration</h2>
          {snapshot.kind === 'live' && <PersonalCalibration attention={attention} enabled={Boolean(snapshot.session)} />}
          <div className="session-setup__camera"><FocusSetup player={player} lecture={lecture} focus={focus} participant={attention.participant} onCalibrationBusyChange={setCalibratingCamera} /></div>
        </section>
      </div>
      <footer className="session-setup__footer">
        <details className="setup-help"><summary>What is saved?</summary><p>Your profile and calibration settings stay on this computer. Camera frames and raw EEG are not stored by setup.</p></details>
        <button className="button button--primary" disabled={calibratingCamera} onClick={close}>Continue to lecture</button>
      </footer>
    </div>
  </dialog>;
}
