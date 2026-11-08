import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLaunchToken } from '../integration/live/pairing';
import { questionApi, type ProviderSelection, type QuestionProviderStatus } from './client';

type Model = { id: string; label: string };
const NO_MODELS: Model[] = [];

function preferredAccount(status: QuestionProviderStatus | null) {
  const accounts = status?.chatgpt.accounts ?? [];
  return accounts.find((account) => account.id === status?.chatgpt.lastConnectedAccountId && account.connected)
    ?? accounts.find((account) => account.connected && account.planEnabled)
    ?? accounts[0];
}

export function useQuestionProvider(backendUrl: string, enabled: boolean) {
  const [selection, updateSelection] = useState<ProviderSelection>({ provider: 'openrouter' });
  const [status, setStatus] = useState<QuestionProviderStatus | null>(null);
  const [catalog, setCatalog] = useState<{ key: string; models: Model[]; error: string } | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const attempt = useRef<{ previousIds: Set<string>; existing?: string } | null>(null);
  const options = useCallback(() => ({ backendUrl, launchToken: getLaunchToken() }), [backendUrl]);
  const setSelection = useCallback((next: ProviderSelection) => {
    updateSelection((previous) => {
      let chosen = next.provider === 'chatgpt' && !next.accountId
        ? { ...next, accountId: preferredAccount(status)?.id } : next;
      if (chosen.provider === 'chatgpt' && previous.provider === 'chatgpt' && chosen.accountId === previous.accountId) {
        chosen = { ...chosen, model: chosen.model ?? previous.model };
      }
      return chosen.provider === previous.provider && chosen.accountId === previous.accountId && chosen.model === previous.model ? previous : chosen;
    });
    setMessage('');
  }, [status]);

  const refresh = useCallback(async (reloadModels = true) => {
    if (!enabled) return;
    if (!getLaunchToken()) {
      setMessage('Open the backend pairing link to connect recall questions.');
      return;
    }
    try {
      const next = await questionApi<QuestionProviderStatus>('/status', options());
      setStatus(next);
      setMessage('');
      const currentAttempt = attempt.current;
      if (currentAttempt && !next.chatgpt.pending) {
        const completed = next.chatgpt.accounts.find((account) => account.connected && (
          account.id === next.chatgpt.lastConnectedAccountId || account.id === currentAttempt.existing
          || !currentAttempt.previousIds.has(account.id)
        ));
        if (completed && !next.chatgpt.error) {
          updateSelection((previous) => previous.provider === 'chatgpt'
            ? { provider: 'chatgpt', accountId: completed.id } : previous);
          setModelRevision((revision) => revision + 1);
        }
        attempt.current = null;
        setAuthorizationUrl(null);
      }
      updateSelection((previous) => previous.provider === 'chatgpt' && !previous.accountId
        ? { ...previous, accountId: preferredAccount(next)?.id } : previous);
      if (reloadModels) setModelRevision((revision) => revision + 1);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : 'Cannot read question provider status.');
    }
  }, [enabled, options]);
  useEffect(() => { void refresh(false); }, [refresh]);
  useEffect(() => {
    if (!status?.chatgpt.pending && !authorizationUrl) return;
    const timer = window.setInterval(() => { void refresh(false); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.chatgpt.pending, authorizationUrl, refresh]);

  const accountId = selection.provider === 'chatgpt' ? selection.accountId : undefined;
  const connected = !!status?.chatgpt.accounts.find((account) => account.id === accountId && account.connected && account.planEnabled);
  const catalogKey = JSON.stringify([backendUrl, accountId, connected, modelRevision]);
  const models = connected && catalog?.key === catalogKey ? catalog.models : NO_MODELS;
  const modelsLoading = !!accountId && connected && catalog?.key !== catalogKey;
  const modelError = catalog?.key === catalogKey ? catalog.error : '';
  useEffect(() => {
    if (!enabled || !accountId || !connected) return;
    const controller = new AbortController();
    questionApi<{ models: Model[] }>(`/chatgpt/models?accountId=${encodeURIComponent(accountId)}`, { ...options(), signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalog({ key: catalogKey, models: result.models, error: result.models.length ? '' : 'No models are available for this account. Refresh models or check ChatGPT plan access.' });
        updateSelection((previous) => {
          if (previous.provider !== 'chatgpt' || previous.accountId !== accountId) return previous;
          const model = result.models.some((item) => item.id === previous.model) ? previous.model : result.models[0]?.id;
          return previous.model === model ? previous : { ...previous, model };
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setCatalog({ key: catalogKey, models: [], error: error instanceof Error ? error.message : 'Cannot load ChatGPT models.' });
      });
    return () => controller.abort();
  }, [enabled, accountId, connected, catalogKey, options]);

  const connect = useCallback(async (existing?: string, requestPlanUsage = false) => {
    if (busy || status?.chatgpt.pending) return;
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setBusy(true);
    setMessage('');
    attempt.current = { previousIds: new Set(status?.chatgpt.accounts.map((account) => account.id)), existing };
    try {
      const result = await questionApi<{ authorizationUrl: string }>('/chatgpt/connect', options(), { accountId: existing, requestPlanUsage });
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('Unexpected sign-in destination.');
      if (popup) popup.location.href = url.href;
      setAuthorizationUrl(url.href);
      await refresh(false);
    } catch (error) {
      popup?.close();
      attempt.current = null;
      setMessage(error instanceof Error ? error.message : 'Cannot start ChatGPT sign-in.');
    } finally { setBusy(false); }
  }, [busy, status, options, refresh]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await questionApi('/chatgpt/cancel', options(), {});
      attempt.current = null;
      setAuthorizationUrl(null);
      await refresh(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Cannot cancel ChatGPT sign-in.'); }
    finally { setBusy(false); }
  }, [options, refresh]);
  const disconnect = useCallback(async () => {
    if (!accountId) return;
    setBusy(true);
    try {
      const result = await questionApi<{ revocationConfirmed: boolean }>('/chatgpt/disconnect', options(), { accountId });
      await refresh(false);
      setMessage(result.revocationConfirmed ? 'ChatGPT disconnected.' : 'Disconnected locally. Remote revocation was not confirmed; disconnect ReMind in ChatGPT settings too.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Cannot disconnect ChatGPT.'); }
    finally { setBusy(false); }
  }, [accountId, options, refresh]);
  const ready = enabled && (selection.provider === 'openrouter' ? !!status?.configured : connected && models.some((model) => model.id === selection.model));
  return useMemo(() => ({ selection, setSelection, status, models, modelsLoading, modelError, message, busy, authorizationUrl, connect, cancel, disconnect, refresh, ready }),
    [selection, setSelection, status, models, modelsLoading, modelError, message, busy, authorizationUrl, connect, cancel, disconnect, refresh, ready]);
}
