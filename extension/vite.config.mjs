import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = new URL('.', import.meta.url).pathname;

export default defineConfig({
  root,
  base: './',
  publicDir: resolve(root, 'public'),
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(root, 'src/background.js'),
        terminal: resolve(root, 'terminal.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
