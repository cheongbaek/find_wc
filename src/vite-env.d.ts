/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KAKAO_JS_KEY: string;
  /** 저장 서버(Cloudflare Worker) 주소 — 비어 있으면 'GitHub 에 저장' 이 토큰을 묻는다 */
  readonly VITE_SAVE_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
