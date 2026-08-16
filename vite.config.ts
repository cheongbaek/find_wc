import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 배포 위치에 따라 base 경로가 달라진다.
// - Vercel/루트 배포: "/" (기본값)
// - GitHub Pages(cheongbaek/find_wc): "/find_wc/" — 워크플로에서 BASE_PATH로 주입
const base = process.env.BASE_PATH ?? "/";

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  // host: true 로 열어 두면 같은 공유기의 다른 기기(태블릿 등)에서도 접속된다.
  // 단, 카카오 개발자 콘솔의 플랫폼 > Web 에 그 주소도 등록해야 지도가 뜬다.
  server: { host: true },
});
