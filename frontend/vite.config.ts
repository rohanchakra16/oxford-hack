import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Dev server binds to loopback only. VITE_BACKEND_URL selects the backend (default http://127.0.0.1:8765).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    '@mediapipe/tasks-vision': fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision', import.meta.url)),
  } },
  publicDir: fileURLToPath(new URL('../gaze/public', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.EVALUATION_PLAYER_PORT ?? 5173), strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../', import.meta.url))] },
    proxy: { '/evaluation-api': { target: process.env.EVALUATION_API_URL ?? 'http://127.0.0.1:18766', rewrite: (path) => path.replace('/evaluation-api', '') } },
  },
  preview: { host: '127.0.0.1', strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
