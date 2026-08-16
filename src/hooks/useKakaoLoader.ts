import { useEffect, useState } from "react";

const SDK_URL = "https://dapi.kakao.com/v2/maps/sdk.js";

type Status = "loading" | "ready" | "error" | "no-key";

// 카카오맵 JS SDK를 동적으로 로드한다.
// autoload=false 로 불러오고 kakao.maps.load()로 초기화 완료를 보장한다.
export function useKakaoLoader(): Status {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const key = import.meta.env.VITE_KAKAO_JS_KEY;
    if (!key) {
      setStatus("no-key");
      return;
    }
    if (window.kakao?.maps) {
      setStatus("ready");
      return;
    }

    const existing = document.getElementById("kakao-sdk") as HTMLScriptElement | null;
    const onLoad = () => window.kakao.maps.load(() => setStatus("ready"));

    if (existing) {
      existing.addEventListener("load", onLoad);
      return () => existing.removeEventListener("load", onLoad);
    }

    const script = document.createElement("script");
    script.id = "kakao-sdk";
    script.async = true;
    script.src = `${SDK_URL}?autoload=false&appkey=${key}`;
    script.addEventListener("load", onLoad);
    script.addEventListener("error", () => setStatus("error"));
    document.head.appendChild(script);

    return () => {
      script.removeEventListener("load", onLoad);
    };
  }, []);

  return status;
}
