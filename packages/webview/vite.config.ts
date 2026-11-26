import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
