import { defineConfig } from 'vite';
import adocHtml from './vite-plugins/adoc-html';

export default defineConfig({
  root: '.',
  /* GitHub Pages serves this repo from a subpath
   * (openpowershift.github.io/prot-setpoint-diagram/), not the domain
   * root — an absolute base would point every asset at the wrong URL. */
  base: './',
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
