import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://peninsulasai.com',
  build: { format: 'directory' },
  compressHTML: false,
});
