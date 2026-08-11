import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { visualizer } from "rollup-plugin-visualizer";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const serverPort = Number(process.env.RIN_SERVER_PORT || "11499");
  const serverTarget = `http://127.0.0.1:${serverPort}`;
  const cacheDir = process.env.RIN_VITE_CACHE_DIR || "../.vite/client";

  // Build-time version string baked into the client bundle. Used to cache-bust
  // locale JSON files (served with `cache-control: immutable` via the worker's
  // [assets] config) so that newly added translation keys are re-fetched by
  // browsers that cached an older, key-missing locale. Defaults to the build
  // timestamp so every deploy produces a distinct URL and defeats stale caches.
  const buildVersion = process.env.RIN_BUILD_VERSION || String(Date.now());

  return {
    cacheDir,
    // Note: Client configuration is fetched from server at runtime.
    // Only the build version (for locale cache-busting) is injected here.
    define: {
      __RIN_BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    build: {
      outDir: '../dist/client',
      emptyOutDir: true,
    },
    plugins: [
      react(),
      // Only open visualizer in build mode
      visualizer({ open: !isDev })
    ],
    server: {
      proxy: {
        "/api": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/rss.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/atom.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/rss.json": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/feed.json": {
          target: serverTarget,
          changeOrigin: false,
        },
        "/feed.xml": {
          target: serverTarget,
          changeOrigin: false,
        },
      },
    },
    // Vitest configuration
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
    },
  }
})
