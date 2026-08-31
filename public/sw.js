/*
 * ★자폭 서비스워커★ — 옛 화장실SOS PWA 가 브라우저에 남긴 서비스워커를 걷어낸다.
 * ════════════════════════════════════════════════════════════════════════════
 * 무엇을 고치는 것인가 :
 *   https://cheongbaek.github.io/find_wc/ 를 열면 ★화장실 지도가 먼저 뜨고★
 *   Ctrl+Shift+R 을 해야 궤적 비교 화면이 나오는 문제.
 *
 * 원인 (2026-08-31 확인) :
 *   전환 전(42d9d8b~1) 이 사이트는 vite-plugin-pwa(Workbox) 로 만든 PWA 였고
 *   registerType:"autoUpdate", scope:"/find_wc/" 로 ★sw.js 를 등록★했다. 그 워커는
 *   화장실SOS 의 index.html 을 precache 에 담고 navigation fallback 으로 돌려준다.
 *   전환 커밋이 플러그인을 걷어내 sw.js 는 404 가 됐지만 —
 *
 *     ★서비스워커는 스크립트가 404 가 되어도 등록이 해제되지 않는다★
 *
 *   이미 등록된 워커는 자기 사본으로 계속 동작하고 precache 도 그대로 남는다.
 *   그래서 서버에는 새 화면이 올라가 있는데(실제로 그렇다) 방문자만 옛 화면을
 *   본다. Ctrl+Shift+R 은 ★서비스워커를 우회★하므로 그때만 새 화면이 보인 것이다.
 *
 * 그래서 404 로 방치하면 안 된다 — ★같은 자리에 '스스로 지워지는' 워커를 올린다★.
 * 다음 방문에서 브라우저가 sw.js 업데이트를 확인할 때 이 파일을 새 스크립트로
 * 받아 설치하고, 아래 activate 가 캐시를 전부 지운 뒤 자기 등록까지 해제한다.
 * 열려 있던 탭은 navigate() 로 한 번 다시 불러 곧바로 새 화면이 되게 한다.
 *
 * ⚠️ 이 파일을 ★지우지 말 것★. 지우면 다시 404 가 되어, 아직 한 번도 재방문하지
 *    않은 브라우저에 남은 옛 워커를 영구히 걷어낼 수 없다. 유지비는 0 이다.
 *    (지금 앱은 서비스워커를 쓰지 않는다 — 이 파일은 청소 전용이다.)
 */

self.addEventListener("install", () => {
  // 대기하지 않고 곧바로 활성화된다 — 청소를 다음 방문까지 미룰 이유가 없다.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // ① 옛 precache(workbox-precache-v2-…)와 런타임 캐시(restroom-tiles)를 전부 지운다
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));

      // ② 자기 등록을 해제한다 — 이 시점 이후 이 사이트에는 서비스워커가 없다
      await self.registration.unregister();

      // ③ 열려 있는 탭을 다시 불러 준다. 이 워커가 죽기 전에 넘겨줘야 하므로
      //    사용자가 직접 새로고침할 것을 기대하지 않는다.
      const windows = await self.clients.matchAll({ type: "window" });
      await Promise.all(windows.map((client) => client.navigate(client.url)));
    })()
  );
});

// 활성화가 끝나기 전에 들어온 요청이 옛 캐시로 가지 않게 ★항상 네트워크★로 보낸다.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
