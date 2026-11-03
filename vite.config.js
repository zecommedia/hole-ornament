import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.PORT || 4500);

// UI source: ui/   Build output: ui/dist (served by server.js in production).
// Dev server runs on :5173 and proxies /api → the Express API on :4500.
export default defineConfig({
    plugins: [react()],
    root: path.resolve(__dirname, 'ui'),
    base: './',
    build: {
        outDir: path.resolve(__dirname, 'ui/dist'),
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
        },
    },
});
