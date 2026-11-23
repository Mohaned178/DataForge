import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const apiHost = env.API_HOST === undefined || env.API_HOST === '0.0.0.0' || env.API_HOST === '::' ? '127.0.0.1' : env.API_HOST;
  const target = env.WEB_API_URL ?? `http://${apiHost}:${env.API_PORT ?? '3000'}`;
  const server = { host: env.WEB_HOST ?? '127.0.0.1', port: Number(env.WEB_PORT ?? '5173'), strictPort: true };
  const proxy = { '/api': { target, rewrite: (path: string) => path.replace(/^\/api/, '') } };
  return {
    plugins: [react()],
    server: { ...server, proxy },
    preview: { ...server, proxy },
    test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
  };
});
