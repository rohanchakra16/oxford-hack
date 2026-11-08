import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, options: { configured?: boolean; skip?: boolean; fail?: boolean } = {}) {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.addInitScript(() => sessionStorage.setItem('oxford-hack.launch-token', 'synthetic-test-token-123'));
  await page.route('**/api/v0/questions**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path.endsWith('/models')) return route.fulfill({ json: { models: [{ id: 'account-model', label: 'Account model' }] } });
      return route.fulfill({ json: { configured: options.configured ?? true, model: 'openrouter/free', chatgpt: {
        pending: false, error: null, accounts: [{ id: 'account-1', label: 'demo@example.test', connected: true, planEnabled: true }],
      } } });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    sent.push({ path, body });
    if (path.endsWith('/context')) return route.fulfill({ json: { contextId: 'synthetic-context', blockCount: 3 } });
    if (path.endsWith('/connect')) return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=synthetic' } });
    if (options.fail) return route.fulfill({ status: 504, json: { error: 'timeout', message: 'The selected provider took too long.' } });
    return route.fulfill({ json: options.skip
      ? { status: 'skipped_non_instructional', skipReason: 'This passage is a lecture break.' }
      : { status: 'ready', question: 'How does resistance affect current?', suggestedAnswer: 'Current decreases.', supportingQuote: 'increasing resistance reduces current', quoteVerified: true, model: 'account-model' } });
  });
  await page.goto('/e2e/questions/fixture.html');
  return sent;
}

test('explicit consent gates transcript processing and a single context is reused', async ({ page }) => {
  const sent = await setup(page);
  await expect(page.getByRole('button', { name: 'Test recall b1', exact: true })).toBeDisabled();
  expect(sent).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test recall b1', exact: true }).click();
  await expect(page.getByTestId('saved-b1').getByTestId('bookmark-question-text')).toHaveText('How does resistance affect current?');
  await expect(page.getByTestId('bookmark-question-answer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show suggested answer' }).click();
  await expect(page.getByTestId('bookmark-question-answer')).toContainText('Current decreases.');
  await page.getByRole('button', { name: 'Test recall b2', exact: true }).click();
  await expect(page.getByTestId('saved-b2').getByTestId('bookmark-question-text')).toBeVisible();
  expect(sent.filter((request) => request.path.endsWith('/context'))).toHaveLength(1);
  expect(sent[0]!.body.sentences).toHaveLength(3);
});

test('ChatGPT account models are selectable and provider changes clear consent and old questions', async ({ page }) => {
  const sent = await setup(page);
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await page.getByLabel('ChatGPT account').selectOption('account-1');
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('account-model');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test recall b1', exact: true }).click();
  await expect(page.getByTestId('bookmark-question-text')).toBeVisible();
  expect(sent.every((request) => (request.body.selection as { provider: string }).provider === 'chatgpt')).toBe(true);
  await page.getByLabel('Question provider').selectOption('openrouter');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('bookmark-question-text')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test recall b1', exact: true })).toBeDisabled();
});

test('nonteaching passages skip questions while saved bookmarks remain', async ({ page }) => {
  await setup(page, { skip: true });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test recall b2', exact: true }).click();
  await expect(page.getByTestId('bookmark-question-skipped')).toContainText('lecture break');
  await expect(page.getByTestId('saved-b1')).toBeVisible();
  await expect(page.getByTestId('saved-b2')).toBeVisible();
  await expect(page.getByTestId('bookmark-question-text')).toHaveCount(0);
});

test('missing OpenRouter configuration leaves ChatGPT selectable', async ({ page }) => {
  const sent = await setup(page, { configured: false });
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByText('OpenRouter needs an API key', { exact: false }).first()).toBeVisible();
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await page.getByLabel('ChatGPT account').selectOption('account-1');
  await expect(page.getByRole('checkbox')).toBeEnabled();
  expect(sent).toHaveLength(0);
});

test('Continue with ChatGPT opens the supported authorization destination', async ({ page, context }) => {
  await setup(page);
  await context.route('https://auth.openai.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic authorization page</h1>' }));
  await page.getByLabel('Question provider').selectOption('chatgpt');
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Reconnect ChatGPT', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://auth.openai.com/api/accounts/authorize?state=synthetic');
  await expect(popup.getByRole('heading')).toHaveText('Synthetic authorization page');
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(['oxford-hack.launch-token']);
  await popup.close();
});

test('provider failures are retryable and preserve both bookmarks', async ({ page }) => {
  await setup(page, { fail: true });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test recall b1', exact: true }).click();
  await expect(page.getByTestId('saved-b1')).toContainText('Question unavailable');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('bookmark-question-text')).toHaveCount(0);
  await expect(page.getByTestId('saved-b2')).toBeVisible();
});

test('provider switches discard a late response from the previous provider', async ({ page }) => {
  await setup(page);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v0/questions', async (route) => {
    await gate;
    await route.fulfill({ json: { status: 'ready', question: 'Old provider reply?', suggestedAnswer: 'Old answer.' } }).catch(() => {});
  });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Test recall b1', exact: true }).click();
  await expect(page.getByTestId('saved-b1')).toContainText('Preparing lecture context');
  await page.getByLabel('Question provider').selectOption('chatgpt');
  release!();
  await expect(page.getByTestId('bookmark-question-text')).toHaveCount(0);
  await expect(page.getByTestId('saved-b1')).toBeVisible();
});

test('selecting ChatGPT automatically selects a connected account and enables consent', async ({ page }) => {
  const sent = await setup(page, { configured: false });
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await expect(page.getByLabel('ChatGPT account')).toHaveValue('account-1');
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('account-model');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('checkbox')).toBeChecked();
  expect(sent).toHaveLength(0);
  await page.getByRole('button', { name: 'Test recall b1', exact: true }).click();
  await expect(page.getByTestId('bookmark-question-text')).toBeVisible();
});

test('model loading failure can be retried without reconnecting', async ({ page }) => {
  await setup(page);
  let fail = true;
  await page.route('**/chatgpt/models?**', async (route) => {
    await route.fulfill(fail
      ? { status: 502, json: { error: 'provider_error', message: 'Cannot load account models.' } }
      : { json: { models: [{ id: 'recovered-model', label: 'Recovered model' }] } });
  });
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry loading models' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry loading models' }).click();
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('recovered-model');
  await page.getByRole('checkbox').check();
});

test('a new sign-in is detected and selected automatically, even with another account present', async ({ page, context }) => {
  await setup(page);
  let pending = false;
  let completed = false;
  await context.route('https://auth.openai.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' }));
  await page.route('**/questions/status', (route) => route.fulfill({ json: {
    configured: false, model: 'unused', chatgpt: { pending, error: null, lastConnectedAccountId: completed ? 'new-account' : 'account-1', accounts: [
      { id: 'account-1', label: 'First account', connected: true, planEnabled: true },
      ...(completed ? [{ id: 'new-account', label: 'New account', connected: true, planEnabled: true }] : []),
    ] },
  } }));
  await page.route('**/chatgpt/connect', (route) => {
    pending = true;
    return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=new' } });
  });
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await page.getByRole('button', { name: 'Add another account' }).click();
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
  completed = true;
  pending = false;
  await expect(page.getByLabel('ChatGPT account')).toHaveValue('new-account');
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('account-model');
  await expect(page.getByRole('checkbox')).toBeEnabled();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
});

test('abandoned sign-in can be cancelled and immediately restarted', async ({ page, context }) => {
  await setup(page);
  let pending = false;
  await context.route('https://auth.openai.com/**', (route) => route.fulfill({ contentType: 'text/html', body: 'Sign in' }));
  await page.route('**/questions/status', (route) => route.fulfill({ json: {
    configured: false, model: 'unused', chatgpt: { pending, error: null, accounts: [] },
  } }));
  await page.getByRole('button', { name: 'Refresh provider status' }).click();
  await page.route('**/chatgpt/connect', (route) => {
    pending = true;
    return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=cancel' } });
  });
  await page.route('**/chatgpt/cancel', (route) => {
    pending = false;
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
});

test('declined plan usage has an explicit permission recovery action', async ({ page, context }) => {
  await setup(page);
  await context.route('https://auth.openai.com/**', (route) => route.fulfill({ contentType: 'text/html', body: 'Consent' }));
  await page.route('**/questions/status', (route) => route.fulfill({ json: {
    configured: false, model: 'unused', chatgpt: { pending: false, error: null, accounts: [
      { id: 'account-1', label: 'Signed in, plan off', connected: true, planEnabled: false },
    ] },
  } }));
  await page.getByRole('button', { name: 'Refresh provider status' }).click();
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await expect(page.getByRole('checkbox')).toBeDisabled();
  const request = page.waitForRequest('**/chatgpt/connect');
  await page.getByRole('button', { name: 'Enable ChatGPT plan usage', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ accountId: 'account-1', requestPlanUsage: true });
});

test('switching accounts never keeps a previous account model ready', async ({ page }) => {
  await setup(page);
  await page.route('**/questions/status', (route) => route.fulfill({ json: {
    configured: false, model: 'unused', chatgpt: { pending: false, error: null, accounts: [
      { id: 'account-1', label: 'First', connected: true, planEnabled: true },
      { id: 'account-2', label: 'Second', connected: true, planEnabled: true },
    ] },
  } }));
  await page.getByRole('button', { name: 'Refresh provider status' }).click();
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('account-model');
  await page.getByRole('checkbox').check();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/chatgpt/models?accountId=account-2', async (route) => {
    await gate;
    await route.fulfill({ json: { models: [{ id: 'second-model', label: 'Second model' }] } });
  });
  await page.getByLabel('ChatGPT account').selectOption('account-2');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  release();
  await expect(page.getByLabel('ChatGPT model')).toHaveValue('second-model');
  await expect(page.getByRole('checkbox')).toBeEnabled();
});

test('recall setup fits a narrow screen and keeps consent usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await setup(page);
  await page.getByLabel('Question provider').selectOption('chatgpt');
  await page.getByRole('checkbox').check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('question-provider-controls').screenshot({ path: testInfo.outputPath('provider-mobile.png') });
});

test('an outdated backend explains why connection setup is unavailable', async ({ page }) => {
  const sent = await setup(page);
  await page.route('**/questions/status', (route) => route.fulfill({ status: 404, json: { detail: 'Not Found' } }));
  await page.getByRole('button', { name: 'Refresh provider status' }).click();
  await expect(page.getByText('This backend is missing recall-question support.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  expect(sent).toHaveLength(0);
});
