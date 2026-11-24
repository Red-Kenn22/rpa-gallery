// Subset of Vite's import.meta.env (merges with vite/client's identical declarations).
interface ImportMetaEnv {
  readonly PROD: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
