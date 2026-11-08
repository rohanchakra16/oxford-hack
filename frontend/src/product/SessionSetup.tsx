import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LoadedLecture, PlayerHandle } from '../player';
import type { ReviewClientSnapshot } from '../integration';
import { FocusSetup } from '../focus/FocusSetup';
import { PersonalCalibration, type usePersonalAttention } from '../focus/usePersonalAttention';
import type { useFocusReview } from '../focus/useFocusReview';
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
        <span className="session-setup__eyebrow">SESSION SETUP</span>
        <button className="button button--outline button--small" disabled={calibratingCamera} onClick={close}>Back to lecture <span aria-hidden="true">↗</span></button>
      </header>
      <div className="session-setup__intro">
        <h1 id="session-setup-title">A little setup. A clearer lecture.</h1>
        <p>Connect your devices and calibrate here. Your saved personal baseline is checked automatically for each new lecture.</p>
      </div>
      <div className="session-setup__grid">
        <section className="session-setup__card" aria-labelledby="prerequisites-title">
          <span className="session-setup__step">01 / CONNECTION</span>
          <h2 id="prerequisites-title">Before you begin</h2>
          <ol className="setup-checklist">
            <li><span className={`setup-check ${connected ? 'setup-check--ready' : ''}`} aria-hidden="true">{connected ? '✓' : '1'}</span><div><strong>Local connection</strong><p>{connected ? 'Connected automatically. Keep the launcher running.' : snapshot.connection.detail}</p></div></li>
            <li><span className={`setup-check ${lecture ? 'setup-check--ready' : ''}`} aria-hidden="true">{lecture ? '✓' : '2'}</span><div><strong>Your lecture</strong><p>{lecture ? lecture.fileName : 'Open a local video in the lecture player to begin calibration.'}</p>{!lecture && <button className="button button--quiet button--small" onClick={close}>Choose a lecture</button>}</div></li>
            <li><span className={`setup-check ${profile ? 'setup-check--ready' : ''}`} aria-hidden="true">{profile ? '✓' : '3'}</span><div><strong>Personal baseline</strong><p>{profile ? 'A compatible saved baseline is loaded. No repeat EEG calibration needed.' : 'Calibrate once with usable EEG. We remember your baseline for future lectures.'}</p></div></li>
          </ol>
          {devices}
          <details className="setup-help">
            <summary>Device or model unavailable?</summary>
            <p>Turn on and connect your Unicorn headset, check electrode contact, and keep the local launcher running. The Unicorn SDK and your team’s EEG model must be installed once on this computer.</p>
            <p>If the model has not been supplied, attention stays unavailable. You can still watch and save review markers.</p>
            <a href="/diagnostics" target="_blank" rel="noreferrer">Open system diagnostics ↗</a>
          </details>
        </section>
        <section className="session-setup__card" aria-labelledby="calibration-title">
          <span className="session-setup__step">02 / CALIBRATION</span>
          <h2 id="calibration-title">Make it yours</h2>
          <p className="session-setup__description">Use the same local profile each time. Camera checks stay here; EEG calibration can continue while you watch.</p>
          {snapshot.kind === 'live' && <PersonalCalibration attention={attention} enabled={Boolean(snapshot.session)} />}
          <div className="session-setup__camera"><FocusSetup player={player} lecture={lecture} focus={focus} participant={attention.participant} onCalibrationBusyChange={setCalibratingCamera} /></div>
        </section>
      </div>
      <footer className="session-setup__footer">
        <p>Saved on this computer: profile and calibration settings. Camera frames and raw EEG are not stored by setup.</p>
        <button className="button button--primary" disabled={calibratingCamera} onClick={close}>Continue to lecture</button>
      </footer>
    </div>
  </dialog>;
}
