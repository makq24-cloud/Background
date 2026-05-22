import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site is served from /Background/.
export default defineConfig({
  base: '/Background/',
  plugins: [react()],
  build: {
    target: 'es2020',
  },
});
