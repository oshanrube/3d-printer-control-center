import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // During `npm run dev`, proxy API+WS to the backend on :8082
    proxy: {
      '/api': 'http://localhost:8082',
      '/ws': { target: 'ws://localhost:8082', ws: true },
    },
  },
});
