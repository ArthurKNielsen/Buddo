import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the UI runs on Vite and talks to the Buddo server (npm run dev starts both).
const server = process.env.BUDDO_SERVER || 'http://127.0.0.1:4141';

export default defineConfig({
  // Set BUDDO_BASE=/RepoName/ when hosting under a sub-path (GitHub Pages).
  base: process.env.BUDDO_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/llm': { target: server, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
