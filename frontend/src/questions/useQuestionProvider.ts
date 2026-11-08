import { useCallback, useEffect, useMemo, useState } from 'react';
import { getLaunchToken } from '../integration/live/pairing';
import { questionApi, type ProviderSelection, type QuestionProviderStatus } from './client';

export function useQuestionProvider(backendUrl: string, enabled: boolean) {
  const [selection, setSelection] = useState<ProviderSelection>({ provider: 'openrouter' });
  const [status, setStatus] = useState<QuestionProviderStatus | null>(null);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [message, setMessage] = useState('');
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const options = useCallback(() => ({ backendUrl, launchToken: getLaunchToken() }), [backendUrl]);
  const refresh = useCallback(async () => {
    if (!enabled || !getLaunchToken()) return;
    try { setStatus(await questionApi<QuestionProviderStatus>('/status', options())); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Cannot read question provider status.'); }
  }, [enabled, options]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.chatgpt.pending) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.chatgpt.pending, refresh]);

  const accountId = selection.provider === 'chatgpt' ? selection.accountId : undefined;
  const connected = !!status?.chatgpt.accounts.find((account) => account.id === accountId && account.connected && account.planEnabled);
  useEffect(() => {
    if (!accountId || !connected) return;
    const controller = new AbortController();
    questionApi<{ models: Array<{ id: string; label: string }> }>(`/chatgpt/models?accountId=${encodeURIComponent(accountId)}`, { ...options(), signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setModels(result.models);
        setSelection((previous) => previous.accountId === accountId ? {
          ...previous, model: result.models.some((model) => model.id === previous.model) ? previous.model : result.models[0]?.id,
        } : previous);
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Cannot load ChatGPT models.'); });
    return () => controller.abort();
  }, [accountId, connected, options]);

  const connect = useCallback(async (existing?: string) => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setMessage('');
    try {
      const result = await questionApi<{ authorizationUrl: string }>('/chatgpt/connect', options(), { accountId: existing });
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('Unexpected sign-in destination.');
      if (popup) popup.location.href = url.href;
      setAuthorizationUrl(url.href);
      await refresh();
    } catch (error) {
      popup?.close();
      setMessage(error instanceof Error ? error.message : 'Cannot start ChatGPT sign-in.');
    }
  }, [options, refresh]);
  const disconnect = useCallback(async () => {
    if (!accountId) return;
    try {
      const result = await questionApi<{ revocationConfirmed: boolean }>('/chatgpt/disconnect', options(), { accountId });
      setMessage(result.revocationConfirmed ? 'ChatGPT disconnected.' : 'Disconnected locally. Remote revocation was not confirmed; disconnect ReMind in ChatGPT settings too.');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Cannot disconnect ChatGPT.'); }
  }, [accountId, options, refresh]);
  const ready = selection.provider === 'openrouter' ? !!status?.configured : connected && !!selection.model;
  return useMemo(() => ({ selection, setSelection, status, models, message, authorizationUrl, connect, disconnect, refresh, ready }),
    [selection, status, models, message, authorizationUrl, connect, disconnect, refresh, ready]);
}
