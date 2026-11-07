import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev server binds to loopback only. VITE_BACKEND_URL selects the backend (default http://127.0.0.1:8765).
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
