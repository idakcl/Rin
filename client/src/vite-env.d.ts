/// <reference types="vite/client" />

// Injected at build time via Vite `define` (client/vite.config.ts).
// Used to cache-bust locale JSON files served with `cache-control: immutable`.
declare const __RIN_BUILD_VERSION__: string;

declare module 'react-helmet';
declare module 'markdown-toc';