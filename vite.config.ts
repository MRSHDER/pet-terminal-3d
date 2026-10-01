import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed to GitHub Pages under https://mrshder.github.io/pet-terminal-3d/,
// so built asset URLs need that prefix. Change to '/' for a root deploy.
export default defineConfig({
  base: '/pet-terminal-3d/',
  plugins: [react()],
  server: { port: 5173, open: true },
});
