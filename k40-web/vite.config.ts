import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: 'localhost' },
  preview: { port: 4173, host: 'localhost' },
  build: { target: 'es2022' },
  test: { environment: 'node' },
} as any);
