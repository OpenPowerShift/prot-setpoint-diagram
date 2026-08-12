import { defineConfig } from 'vite';
import adocHtml from './vite-plugins/adoc-html';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    lib: false,
  },
  assetsInclude: ['**/*.adoc'],
  plugins: [adocHtml()],
});
