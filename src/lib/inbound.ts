// 안드로이드 매핑 앱(gpsmapper.apk)이 링크로 넘겨준 CSV 를 URL 에서 꺼낸다.
//
// ★왜 쿼리(?)가 아니라 프래그먼트(#)인가★
//   프래그먼트는 ★서버로 전송되지 않는다★. 쿼리로 보내면 GitHub Pages 접근 로그에
//   주행 좌표가 그대로 남는다 — "CSV 는 브라우저 밖으로 나가지 않는다"(CLAUDE.md)는
//   이 앱의 원칙을 깨는 것이므로 ★쿼리를 쓰면 안 된다★.
//
// 형식 : #csvgz=<base64url( gzip( utf-8 CSV ) )>&name=<encodeURIComponent(파일명)>
//   gzip 을 거치는 이유는 길이다. 좌표 텍스트는 반복이 많아 4~5배로 줄고(0.25m 간격
//   4000점 ≈ 272KB → 약 60KB), 안드로이드가 ACTION_VIEW 로 넘기는 URI 는 Binder
//   트랜잭션을 타므로 짧을수록 안전하다. 압축을 앱 쪽에서 하고 여기서 푼다.

/** 프래그먼트에서 찾을 열쇠 — 앱(MainActivity.kt)의 값과 같아야 한다 */
const PAYLOAD_KEY = "csvgz";
const NAME_KEY = "name";

/** base64url(-_, 패딩 없음) → 바이트 */
function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * gzip 해제. ★DecompressionStream 을 전역에서 직접 찾는다★ — 타입 선언(lib.dom.d.ts)에
 * 이 API 가 있는지가 TypeScript 판마다 다르므로, 있으면 쓰고 없으면 안내로 떨어지는
 * 이 방식이 빌드까지 안전하다. 지원 범위는 Chrome 80+ 로 안드로이드 크롬은 전부 든다.
 */
async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const ctor = (globalThis as Record<string, unknown>).DecompressionStream;
  if (typeof ctor !== "function") {
    // 아주 낡은 브라우저. 링크 적재만 포기하고 '파일 선택'은 그대로 쓸 수 있다.
    throw new Error("이 브라우저는 gzip 해제를 지원하지 않습니다 — '파일 선택'으로 올려 주세요.");
  }
  const transform = new (ctor as new (
    format: string
  ) => TransformStream<Uint8Array, Uint8Array>)("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Response(stream as BodyInit).text();
}

export interface InboundCsv {
  name: string;
  text: string;
}

/**
 * 링크에 실려 온 CSV 를 꺼낸다. 없으면 null.
 *
 * ★꺼내는 즉시 주소창의 프래그먼트를 지운다★ 세 가지를 동시에 막는다:
 *   ① 새로고침할 때마다 같은 파일이 또 얹히는 것
 *   ② 사용자가 주소를 복사·공유했을 때 좌표가 함께 나가는 것
 *   ③ 수십 KB 짜리 주소가 방문기록에 쌓이는 것
 * replaceState 로 지우므로 뒤로가기 기록도 남지 않는다.
 */
export async function takeInboundCsv(): Promise<InboundCsv | null> {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const payload = params.get(PAYLOAD_KEY);
  if (!payload) return null;

  const name = params.get(NAME_KEY) || "route.csv";

  // ★await 보다 먼저★ 지운다 — 이 함수가 두 번 불려도(React StrictMode 는 개발
  //   모드에서 effect 를 두 번 실행한다) 두 번째는 null 을 받아 중복 적재가 없다.
  history.replaceState(null, "", window.location.pathname + window.location.search);

  return { name, text: await gunzipToText(base64UrlToBytes(payload)) };
}
