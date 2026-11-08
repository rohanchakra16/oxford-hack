import { useId } from 'react';
import type { useQuestionProvider } from './useQuestionProvider';
import './provider.css';

export interface QuestionProviderControlsProps {
  provider: ReturnType<typeof useQuestionProvider>;
  consented: boolean;
  onConsent: (approved: boolean) => void;
  hasTranscript: boolean;
}

export function QuestionProviderControls({ provider, consented, onConsent, hasTranscript }: QuestionProviderControlsProps) {
  const { selection, setSelection, status, models, modelsLoading, modelError, busy } = provider;
  const hintId = useId();
  const account = status?.chatgpt.accounts.find((item) => item.id === selection.accountId);
  const isChatGPT = selection.provider === 'chatgpt';
  const pending = !!status?.chatgpt.pending;
  const blockedReason = !hasTranscript ? 'Load a transcript to enable recall questions.'
    : !status ? 'Connect to the local backend, then refresh provider status.'
    : !isChatGPT ? (status.configured ? '' : 'OpenRouter needs an API key in the backend environment. You can also choose ChatGPT.')
    : pending ? 'Finish ChatGPT sign-in in the new tab, or cancel to try again.'
    : !account?.connected ? 'Continue with ChatGPT to connect your account.'
    : !account.planEnabled ? 'Enable ChatGPT plan usage to use this account for questions.'
    : modelsLoading ? 'Loading models for your ChatGPT account…'
    : modelError || (!provider.ready ? 'Choose an available ChatGPT model to continue.' : '');
  const canConsent = hasTranscript && provider.ready && !pending;
  const stateLabel = pending ? 'Signing in' : provider.ready ? 'Connected' : account?.connected ? 'Needs attention' : 'Setup needed';
  return (
    <fieldset className="bookmark-question-provider recall-setup" data-testid="question-provider-controls">
      <legend>Recall questions</legend>
      <div className="recall-setup__header">
        <div><span className="recall-setup__eyebrow">STUDY TOOLS</span><h3>Make it stick.</h3><p>Turn saved moments into recall questions.</p></div>
        <span className="recall-setup__badge" data-ready={provider.ready && !pending}>{stateLabel}</span>
      </div>
      <div className="recall-setup__section">
        <label><span className="recall-setup__label"><b>01</b> Choose your connection</span>
          <select aria-label="Question provider" value={selection.provider} disabled={busy || pending} onChange={(event) => setSelection({ provider: event.target.value as 'openrouter' | 'chatgpt' })}>
            <option value="openrouter">OpenRouter / free models</option>
            <option value="chatgpt">My ChatGPT connection</option>
          </select>
        </label>
        {!isChatGPT ? <p className="recall-setup__hint">{status?.configured ? `Ready with ${status.model}.` : 'OpenRouter needs an API key in the backend environment.'}</p> : (
          <div className="recall-setup__account">
            {!!status?.chatgpt.accounts.length && <label>ChatGPT account
              <select aria-label="ChatGPT account" disabled={busy || pending} value={selection.accountId ?? ''} onChange={(event) => setSelection({ provider: 'chatgpt', accountId: event.target.value || undefined })}>
                <option value="">Choose a connected account</option>
                {status.chatgpt.accounts.map((item) => <option key={item.id} value={item.id}>{item.label}{item.connected ? '' : ' — reconnect'}</option>)}
              </select>
            </label>}
            {pending ? <div className="recall-setup__notice" role="status">
              <strong>Finish signing in with ChatGPT</strong>
              <p>Approve access in the new tab, then come back here. We’ll detect the connection automatically.</p>
              <div className="recall-setup__actions">
                {provider.authorizationUrl && <a href={provider.authorizationUrl} target="_blank" rel="noreferrer">Open ChatGPT sign-in ↗</a>}
                <button type="button" disabled={busy} onClick={() => { void provider.cancel(); }}>Cancel sign-in</button>
              </div>
            </div> : <>
              <div className="recall-setup__actions">
                <button className="recall-setup__primary" type="button" disabled={busy || !status} onClick={() => { void provider.connect(selection.accountId); }}>
                  {busy ? 'Connecting…' : account?.connected ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
                </button>
                {selection.accountId && <button type="button" disabled={busy} onClick={() => { void provider.connect(); }}>Add another account</button>}
              </div>
              {account?.connected && !account.planEnabled && <div className="recall-setup__notice">
                <strong>Your account is signed in. Plan usage is off.</strong>
                <p>Allow this app to use your ChatGPT plan for recall questions.</p>
                <button type="button" disabled={busy} onClick={() => { void provider.connect(selection.accountId, true); }}>Enable ChatGPT plan usage</button>
              </div>}
              {account?.connected && account.planEnabled && <label>Model
                <select aria-label="ChatGPT model" disabled={modelsLoading || !models.length} value={models.some((model) => model.id === selection.model) ? selection.model : ''} onChange={(event) => setSelection({ ...selection, model: event.target.value })}>
                  {!models.length && <option value="">{modelsLoading ? 'Loading available models…' : 'Models unavailable'}</option>}
                  {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>}
              {modelError && <div className="recall-setup__notice" role="status"><p>{modelError}</p><button type="button" onClick={() => { void provider.refresh(); }}>Retry loading models</button></div>}
              {account?.connected && <button className="recall-setup__text-button" type="button" disabled={busy} onClick={() => { void provider.disconnect(); }}>Disconnect ChatGPT</button>}
            </>}
            <p className="recall-setup__hint">Uses your ChatGPT plan allowance. No API key needed. Sign in again after a backend restart. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage ↗</a></p>
            {status?.chatgpt.error && <p className="recall-setup__notice" role="status">{status.chatgpt.error}</p>}
          </div>
        )}
      </div>
      <div className="recall-setup__section">
        <span className="recall-setup__label"><b>02</b> Allow transcript analysis</span>
        <label className="recall-setup__consent" data-checked={consented}>
          <input aria-describedby={hintId} type="checkbox" checked={consented} disabled={!canConsent && !consented} onChange={(event) => onConsent(event.target.checked)} />
          <span>Allow {isChatGPT ? 'OpenAI through my ChatGPT connection' : 'OpenRouter and its model provider'} to analyse this lecture transcript for a cached overview and topic blocks, then use relevant passages for requested questions.</span>
        </label>
        <p id={hintId} className="recall-setup__hint" role="status">{blockedReason || (consented ? 'Ready. Choose “Test your recall” on a saved moment.' : 'Tick the box to enable questions. Connecting alone never uploads your transcript.')}</p>
      </div>
      <div className="recall-setup__footer"><span>Questions start only when you ask.</span><button type="button" disabled={busy} onClick={() => { void provider.refresh(); }}>Refresh provider status</button></div>
      {provider.message && <p className="recall-setup__notice" role="status">{provider.message}</p>}
    </fieldset>
  );
}
