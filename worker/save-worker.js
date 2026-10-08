/**
 * find_wc 저장 서버 — Cloudflare Worker  [2026-10-08]
 *
 * 사이트(cheongbaek.github.io/find_wc)의 '궤적 생성 → GitHub 에 저장' 을 ★방문자가 아무 절차 없이★
 * 쓰게 하는 중계다. 사이트는 정적 파일이라 쓰기 토큰을 품을 수 없다(번들에 넣으면 누구나 꺼내
 * 리포를 고친다). 그래서 토큰은 ★이 서버의 비밀값 GITHUB_TOKEN 에만★ 두고, 브라우저는 CSV 만 보낸다.
 *
 *   브라우저 ──POST {name, csv, summary}──▶ 이 Worker ──PUT contents API──▶ cheongbaek/find_wc/gps_data
 *
 * 누구나 부를 수 있는 주소이므로 받는 것을 좁게 거른다:
 *   - 출처(Origin)가 ALLOWED_ORIGINS 인 요청만        - 파일 이름은 영숫자·._- 로 된 .csv, gps_data 안에만
 *   - 내용은 latitude,longitude 로 시작하는 ★숫자 CSV★ 만(글자·HTML 은 못 실린다), 1 MB 까지
 *   - ★덮어쓰지 않는다★ — 같은 이름이 있으면 _2, _3 … 을 붙인다(지우기·덮어쓰기는 GitHub 에서 사람이)
 *   - 같은 IP 는 1분에 RATE_MAX 번까지(인스턴스마다 따로 세는 느슨한 한도)
 *
 * 무료 플랜 : 하루 10만 요청, 요청당 CPU 10 ms(바깥 응답을 기다리는 시간은 안 센다). 1 MB 상한은
 * 그 CPU 안에 들게 잡은 값이다(0.25 m 간격이면 약 4.5 km).
 *
 * 배포 절차 : worker/README.md. 이 파일을 Cloudflare 대시보드 편집기에 ★통째로★ 붙여 넣는다.
 * 점검 : 브라우저로 이 Worker 주소 뒤에 ?check=1 을 붙여 열면 토큰·리포 접근을 확인해 준다.
 */

const OWNER = "cheongbaek";
const REPO = "find_wc";
const BRANCH = "main";
const DIR = "gps_data";

/** 이 출처에서 온 브라우저 요청만 받는다 (개발 서버 둘 포함) */
const ALLOWED_ORIGINS = [
  "https://cheongbaek.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];

const NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,95}\.csv$/;
const MAX_BYTES = 1024 * 1024;

// ★파일 전체를 정규식 한 번으로★ 본다 — 줄마다 나눠 보면 1 MB 에 CPU 가 10 ms 를 넘는다.
// 머리줄 latitude,longitude… / 그 아래 줄마다 위도(±90)·경도(±180)·숫자 칸, 두 줄 이상.
// 글자·HTML·빈 줄은 어디에도 들어갈 자리가 없다. 칸 경계가 쉼표로 하나뿐이라 되짚기가 커지지 않는다.
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const LAT = String.raw`-?(?:[0-8]?\d(?:\.\d+)?|90(?:\.0+)?)`;
const LON = String.raw`-?(?:(?:1[0-7]\d|\d?\d)(?:\.\d+)?|180(?:\.0+)?)`;
const CSV_RE = new RegExp(
  String.raw`^latitude,longitude(?:,[A-Za-z0-9_]+)*\r?\n(?:${LAT},${LON}(?:,(?:${NUM})?)*\r?\n){2,}$`
);
const SUFFIX_MAX = 20;
const CONFLICT_RETRY = 3;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

const hits = new Map(); // IP → 최근 요청 시각들 (이 인스턴스 안에서만)

function rateLimited(ip, now) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // 메모리가 끝없이 늘지 않게
  return recent.length > RATE_MAX;
}

/** 매핑 CSV 이면 끝에 줄바꿈을 맞춘 본문, 아니면 null */
function normalizeCsv(csv) {
  const text = csv.endsWith("\n") ? csv : csv + "\n";
  return CSV_RE.test(text) ? text : null;
}

function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "find_wc-save-worker", // GitHub API 는 User-Agent 가 없으면 거절한다
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/** GitHub 의 거절을 사람이 고칠 수 있는 문장으로. ★토큰 값은 절대 싣지 않는다★ */
async function githubProblem(res) {
  let msg = "";
  try {
    const j = await res.json();
    msg = typeof j.message === "string" ? j.message : "";
  } catch {
    /* 본문 없음 */
  }
  switch (res.status) {
    case 401:
      return "저장 서버의 GitHub 토큰이 틀렸거나 기한이 지났습니다 — Cloudflare 의 GITHUB_TOKEN 을 새 토큰으로 바꿔 주세요.";
    case 403:
      return res.headers.get("x-ratelimit-remaining") === "0"
        ? "GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
        : "저장 서버의 토큰에 쓰기 권한이 없습니다 — Contents: Read and write 인지 확인해 주세요.";
    case 404:
      return "저장 서버의 토큰이 cheongbaek/find_wc 를 보지 못합니다 — 토큰의 Repository access 를 확인해 주세요.";
    default:
      return `GitHub 응답 오류 ${res.status}${msg ? ` — ${msg}` : ""}`;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
    const reply = (status, obj) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    const text = (status, body) =>
      new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    const ip = request.headers.get("CF-Connecting-IP") || "?";

    // ── 사전 요청(CORS) ──
    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // ── 점검 (브라우저로 열어 본다) ──
    if (request.method === "GET") {
      if (!env.GITHUB_TOKEN) {
        return text(200, "find_wc 저장 서버 — ★GITHUB_TOKEN 비밀값이 없습니다★ (Settings → Variables and Secrets)");
      }
      if (url.searchParams.get("check") !== "1") {
        return text(200, "find_wc 저장 서버 — 토큰 설정됨. 이 주소 뒤에 ?check=1 을 붙이면 GitHub 접근까지 점검합니다.");
      }
      if (rateLimited(ip, Date.now())) return text(429, "잠시 뒤 다시 시도해 주세요.");
      const res = await github(env, `/contents/${DIR}?ref=${BRANCH}`);
      if (!res.ok) return text(200, `점검 실패 — ${await githubProblem(res)}`);
      return text(200, `점검 통과 — 토큰 유효 · ${OWNER}/${REPO}/${DIR} 접근 가능. 저장 준비가 끝났습니다.`);
    }

    if (request.method !== "POST") return reply(405, { error: "POST 만 받습니다." });
    if (!allowed) return reply(403, { error: "허용되지 않은 출처입니다." });
    if (!env.GITHUB_TOKEN) return reply(500, { error: "저장 서버에 GITHUB_TOKEN 비밀값이 없습니다." });
    if (rateLimited(ip, Date.now())) return reply(429, { error: "저장이 너무 잦습니다. 1분 뒤 다시 시도해 주세요." });

    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BYTES * 2) return reply(413, { error: "파일이 너무 큽니다(1 MB 까지)." });

    let body;
    try {
      body = await request.json();
    } catch {
      return reply(400, { error: "요청 형식이 JSON 이 아닙니다." });
    }
    const name = typeof body?.name === "string" ? body.name : "";
    const csv = typeof body?.csv === "string" ? body.csv : "";
    const summary =
      typeof body?.summary === "string" ? body.summary.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80) : "";

    if (!NAME_RE.test(name)) return reply(400, { error: "파일 이름은 영문·숫자·. _ - 로 쓰고 .csv 로 끝나야 합니다." });
    if (!csv) return reply(400, { error: "내용이 비어 있습니다." });
    if (csv.length > MAX_BYTES) return reply(413, { error: "파일이 너무 큽니다(1 MB 까지)." });
    const csvText = normalizeCsv(csv);
    if (!csvText) {
      return reply(400, {
        error: "매핑 CSV 가 아닙니다 — latitude,longitude 머리줄 아래에 숫자만 있는 줄이 두 줄 이상이어야 합니다.",
      });
    }

    const content = btoa(csvText); // 정규식이 ASCII 만 통과시키므로 그대로 base64 가 된다
    const stem = name.slice(0, -4);

    for (let n = 1; n <= SUFFIX_MAX; n++) {
      const tryName = n === 1 ? name : `${stem}_${n}.csv`;
      if (!NAME_RE.test(tryName)) break;
      const message = `궤적 생성: ${tryName}${summary ? ` (${summary})` : ""} — 사이트에서 저장`;

      for (let attempt = 1; ; attempt++) {
        // base64 는 JSON 에서 고칠 글자가 없다 — JSON.stringify 로 1 MB 를 다시 훑지 않고 이어 붙인다
        const res = await github(env, `/contents/${DIR}/${encodeURIComponent(tryName)}`, {
          method: "PUT",
          body: `{"message":${JSON.stringify(message)},"content":"${content}","branch":"${BRANCH}"}`,
        });

        if (res.ok) {
          const j = await res.json();
          const c = j.content || {};
          return reply(201, {
            name: tryName,
            path: c.path || `${DIR}/${tryName}`,
            size: typeof c.size === "number" ? c.size : csvText.length,
            download_url: c.download_url || `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${DIR}/${tryName}`,
            html_url: c.html_url || `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${DIR}/${tryName}`,
            commit_url: (j.commit && j.commit.html_url) || null,
          });
        }

        // 같은 이름이 있다 (sha 없이 쓰면 422) → 다음 번호로
        if (res.status === 422) {
          const j = await res.json().catch(() => ({}));
          if (/sha/i.test(j.message || "")) break;
          return reply(502, { error: `GitHub 이 저장을 거절했습니다${j.message ? ` — ${j.message}` : ""}` });
        }

        // 그 사이에 다른 저장이 먼저 커밋했다 → 잠깐 뒤 같은 이름으로 다시
        if (res.status === 409 && attempt < CONFLICT_RETRY) {
          await wait(300 * attempt);
          continue;
        }

        const status = res.status === 401 || res.status === 403 || res.status === 404 ? 500 : 502;
        return reply(status, { error: await githubProblem(res) });
      }
    }
    return reply(409, { error: "같은 이름의 파일이 너무 많습니다. 이름을 바꿔 주세요." });
  },
};
