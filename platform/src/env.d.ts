/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "demo" (default): in-browser DemoRepository. "api": own Node API (server/) with real login. */
  readonly VITE_DATA_MODE?: string;
  /** Base URL of the API in api mode. Default: same origin (""). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
