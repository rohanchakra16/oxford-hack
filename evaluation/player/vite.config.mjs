import { defineConfig } from '../../frontend/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
const path = (value) => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
  root: path('./'),
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { react: path('../../frontend/node_modules/react'), 'react-dom': path('../../frontend/node_modules/react-dom') } },
  server: {
    host: '127.0.0.1', port: 15174, strictPort: true,
    fs: { allow: [path('../../')] },
    proxy: { '/evaluation-api': { target: 'http://127.0.0.1:18766', rewrite: (p) => p.replace('/evaluation-api', '') } },
  },
});
