import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// ★옛 PWA 서비스워커 청소 — 이 앱은 서비스워커를 쓰지 않는다★
// 화장실SOS 시절의 워커가 남아 옛 화면을 캐시에서 돌려주는 문제를 막는다.
// 정식 청소는 public/sw.js(자폭 워커)가 하고, 여기는 그 워커가 어떤 이유로든
// 뜨지 못한 경우를 받는 두 번째 그물이다 — 실제 화면이 떴다는 것은 곧
// "지금 등록된 워커가 있다면 그것은 불필요하다"는 뜻이므로 조건 없이 해제한다.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
    .catch(() => {
      /* 사생활 보호 모드 등에서 막힐 수 있다 — 실패해도 앱 동작에는 지장이 없다 */
    });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
