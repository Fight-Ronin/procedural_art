import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import { glslPlugin } from './visualization/vite-plugin-glsl.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [glslPlugin({ root })],
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    // Two entry points: the gallery is a document, the viewer is a canvas.
    // Without naming both, only index.html would be built and gallery.html
    // would 404 in a production build while working perfectly in dev.
    rollupOptions: {
      input: {
        viewer: path.join(root, 'index.html'),
        gallery: path.join(root, 'gallery.html'),
      },
    },
  },
});
