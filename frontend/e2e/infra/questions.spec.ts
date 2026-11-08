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
      : { status: 'ready', question: 'How does resistance affect current?', suggestedAnswer: 'Current decreases.', supportingQuote: 'increasing resistance reduces current', quoteVerified: true, model: 'account-model',
        choices: ['Current decreases.', 'Current increases.', 'Current stays constant.', 'Current doubles.'], correctChoiceIndex: 0 } });
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
  await page.getByTestId('saved-b1').getByLabel('Your answer').fill('The current falls when resistance rises.');
  await page.getByRole('button', { name: 'Submit and compare' }).click();
  await expect(page.getByTestId('recall-answer-feedback')).toContainText('Current decreases.');
  await page.getByRole('button', { name: 'I got it right' }).click();
  await page.getByRole('button', { name: 'Test recall b2', exact: true }).click();
  await expect(page.getByTestId('saved-b2').getByTestId('bookmark-question-text')).toBeVisible();
  expect(sent.filter((request) => request.path.endsWith('/context'))).toHaveLength(1);
  expect(sent[0]!.body.sentences).toHaveLength(3);
});

test('typed quiz waits for all self-checks, reports accuracy and never uploads student answers', async ({ page }) => {
  const sent = await setup(page);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start quiz for 2 saved moments', exact: true }).click();
  const first = page.getByTestId('saved-b1');
  const second = page.getByTestId('saved-b2');
  await first.getByLabel('Your answer').fill('A private explanation for the first answer.');
  await first.getByRole('button', { name: 'Submit and compare' }).click();
  await first.getByRole('button', { name: 'I got it right' }).click();
  await expect(page.getByTestId('quiz-accuracy')).toHaveCount(0);
  await second.getByLabel('Your answer').fill('Another private explanation.');
  await second.getByRole('button', { name: 'Submit and compare' }).click();
  await expect(page.getByTestId('quiz-accuracy')).toHaveCount(0);
  await second.getByRole('button', { name: 'I need to review' }).click();
  await expect(page.getByTestId('quiz-accuracy')).toHaveText('Self-assessed accuracy: 50% (1/2).');
  expect(JSON.stringify(sent)).not.toContain('private explanation');
  expect(sent.filter((request) => request.path.endsWith('/context'))).toHaveLength(1);
  expect(sent.filter((request) => request.path.endsWith('/questions'))).toHaveLength(2);
  await page.getByRole('button', { name: 'Start new quiz for 2 saved moments', exact: true }).click();
  await expect(page.getByTestId('quiz-accuracy')).toHaveCount(0);
  await expect(first.getByLabel('Your answer')).toHaveValue('');
});

test('four-choice quiz marks locally against shuffled choices and reports only the completed score', async ({ page }) => {
  const sent = await setup(page);
  await page.getByRole('checkbox').check();
  await page.getByLabel('Answer format').selectOption('multiple_choice');
  await page.getByRole('button', { name: 'Start quiz for 2 saved moments', exact: true }).click();
  const first = page.getByTestId('saved-b1');
  const second = page.getByTestId('saved-b2');
  await expect(first.getByRole('radio')).toHaveCount(4);
  await expect(first.getByText('Correct answer', { exact: true })).toHaveCount(0);
  await first.getByRole('radio', { name: /Current decreases/ }).check();
  await first.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(first.getByRole('radio').first()).toBeDisabled();
  await expect(page.getByTestId('quiz-accuracy')).toHaveCount(0);
  await second.getByRole('radio', { name: /Current increases/ }).check();
  await second.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByTestId('quiz-accuracy')).toHaveText('Quiz accuracy: 50% (1/2).');
  expect(sent.filter((request) => request.path.endsWith('/questions'))).toHaveLength(2);
  await page.screenshot({ path: 'test-results/questions/quiz-complete.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first.getByRole('radio')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/questions/quiz-mobile.png', fullPage: true });
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
  await expect(page.getByTestId('quiz-accuracy')).toHaveCount(0);
  await expect(page.getByText('No answerable questions were prepared. No accuracy score is reported.')).toBeVisible();
});

test('missing OpenRouter configuration leaves ChatGPT selectable', async ({ page }) => {
  const sent = await setup(page, { configured: false });
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByText('OpenRouter needs an API key')).toBeVisible();
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
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
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
