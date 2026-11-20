/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HELIX_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** app.json version, injected by vite.config.ts (absent in tests and QA harnesses). */
declare const __HELIX_VERSION__: string | undefined;
