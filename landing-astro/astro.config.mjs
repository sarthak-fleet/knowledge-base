// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static Astro landing for Knowledgebase.
//
// LCP path is one round-trip: HTML → fonts → paint. CSS is inlined into
// the HTML head (`build.inlineStylesheets: 'always'`) so no extra
// stylesheet fetch. Tailwind v4 runs through its Vite plugin; lightningcss
// is the minifier.
//
// File-format output (`build.format: 'file'`) emits `index.html` at the
// repo root rather than `index/index.html`.
export default defineConfig({
  site: 'https://knowledgebase-landing.pages.dev',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
    inlineStylesheets: 'always',
  },
  vite: {
    plugins: [tailwindcss()],
    build: { cssMinify: 'lightningcss' },
  },
});
