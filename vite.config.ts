import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// 배포 위치에 따라 base 경로가 달라진다.
// - Vercel/루트 배포: "/" (기본값)
// - GitHub Pages(cheongbaek/find_wc): "/find_wc/" — 워크플로에서 BASE_PATH로 주입
const base = process.env.BASE_PATH ?? "/";

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "화장실SOS",
        short_name: "화장실SOS",
        description: "가장 가까운 공공화장실을 3초 안에",
        theme_color: "#1565c0",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        lang: "ko",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 지도 타일 JSON을 오프라인 캐시 (Phase 5에서 확장)
        runtimeCaching: [
          {
            urlPattern: /\/tiles\/.*\.json$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "restroom-tiles",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  server: { host: true },
});
