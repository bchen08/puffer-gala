import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const server = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: true,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
