import { useEffect, useRef } from "react";

// 하단 안전 문구 아래 고정 배치되는 배너 광고 (slot: wc_under).
// 안내 흐름을 막지 않도록 일반 문서 흐름에 배치하며, sticky/anchor 방식은 쓰지 않는다.
export default function AdBanner() {
  const insRef = useRef<HTMLModElement>(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current) return;
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // 애드센스 스크립트 로드 실패 시(차단기 등) 무시
    }
  }, []);

  return (
    <div className="ad-banner-wrap">
      <ins
        ref={insRef}
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client="ca-pub-6432230820010337"
        data-ad-slot="4423731202"
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
