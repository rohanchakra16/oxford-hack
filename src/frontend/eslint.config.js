import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'src/contracts/generated'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Product components must use the integration adapter, never open their own sockets.
      'no-restricted-globals': ['error', { name: 'WebSocket', message: 'Use src/integration (Person 5) instead.' }],
    },
  },
  {
    files: ['src/integration/live/**', 'src/**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
