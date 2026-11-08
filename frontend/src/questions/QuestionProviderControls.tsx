import type { useQuestionProvider } from './useQuestionProvider';

export interface QuestionProviderControlsProps {
  provider: ReturnType<typeof useQuestionProvider>;
  consented: boolean;
  onConsent: (approved: boolean) => void;
  hasTranscript: boolean;
}

export function QuestionProviderControls({ provider, consented, onConsent, hasTranscript }: QuestionProviderControlsProps) {
  const { selection, setSelection, status, models } = provider;
  const account = status?.chatgpt.accounts.find((item) => item.id === selection.accountId);
  return (
    <fieldset className="bookmark-question-provider" data-testid="question-provider-controls">
      <legend>Recall questions</legend>
      <label>AI provider{' '}
        <select aria-label="Question provider" value={selection.provider} onChange={(event) => setSelection({ provider: event.target.value as 'openrouter' | 'chatgpt' })}>
          <option value="openrouter">OpenRouter / free models</option>
          <option value="chatgpt">My ChatGPT Plus / Pro connection</option>
        </select>
      </label>
      {selection.provider === 'openrouter' ? (
        <p>{status?.configured ? `Backend configured (${status.model}).` : 'OpenRouter needs an API key in the backend environment.'}</p>
      ) : (
        <div>
          <label>ChatGPT account{' '}
            <select aria-label="ChatGPT account" value={selection.accountId ?? ''} onChange={(event) => setSelection({ provider: 'chatgpt', accountId: event.target.value || undefined })}>
              <option value="">Choose a connected account</option>
              {status?.chatgpt.accounts.map((item) => <option key={item.id} value={item.id}>{item.label}{item.connected ? '' : ' — reconnect'}</option>)}
            </select>
          </label>{' '}
          <button type="button" disabled={status?.chatgpt.pending} onClick={() => { void provider.connect(selection.accountId); }}>
            {status?.chatgpt.pending ? 'Waiting for ChatGPT sign-in…' : 'Continue with ChatGPT'}
          </button>{' '}
          {selection.accountId && <button type="button" onClick={() => { void provider.connect(); }}>Add another account</button>}
          {account?.connected && <>
            <p>{account.planEnabled ? 'Connected. ChatGPT plan usage is enabled.' : 'Connected without plan usage. Reconnect and allow plan usage.'}</p>
            <label>Model{' '}
              <select aria-label="ChatGPT model" value={selection.model ?? ''} onChange={(event) => setSelection({ ...selection, model: event.target.value })}>
                {!models.length && <option value="">Loading available models…</option>}
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </label>{' '}
            <button type="button" onClick={() => { void provider.disconnect(); }}>Disconnect ChatGPT</button>
          </>}
          {provider.authorizationUrl && status?.chatgpt.pending && <p><a href={provider.authorizationUrl} target="_blank" rel="noreferrer">Open ChatGPT sign-in</a></p>}
          <p>Uses your Work/Codex plan allowance. Reconnect after restarting the backend. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage</a></p>
          {status?.chatgpt.error && <p role="status">{status.chatgpt.error}</p>}
        </div>
      )}
      <label>
        <input type="checkbox" checked={consented} disabled={!hasTranscript || !provider.ready} onChange={(event) => onConsent(event.target.checked)} />{' '}
        Allow {selection.provider === 'openrouter' ? 'OpenRouter and its model provider' : 'OpenAI through my ChatGPT connection'} to analyse this lecture transcript once for a cached overview and topic blocks, then use relevant passages for requested questions.
      </label>
      {!hasTranscript && <p>Load a transcript to enable recall questions.</p>}
      <p>Questions are requested from saved moments. Bookmarks remain saved when no teaching question is appropriate.</p>
      {provider.message && <p role="status">{provider.message}</p>}
      <button type="button" onClick={() => { void provider.refresh(); }}>Refresh provider status</button>
    </fieldset>
  );
}
