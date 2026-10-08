/**
 * github.ts — 공개 리포의 CSV 를 목록으로 받아 내려받고, 궤적 생성 결과를 리포에 저장한다.
 *
 * ★읽기(목록·내려받기)는 토큰을 쓰지 않는다★ 공개 리포라 익명 요청으로 읽힌다.
 *   익명 한도(IP 당 시간당 60회)가 있다 — 그래서 목록은 한 번 받아 캐시하고,
 *   내려받기는 raw.githubusercontent.com 을 쓴다(그쪽은 이 한도와 별개다).
 *
 * ★쓰기는 'GitHub 에 저장' 하나뿐이다★ [2026-10-08 — 사용자 지시]
 *   궤적 생성 탭에서 사람이 직접 누를 때만, ★단순 기록 폴더(find_wc/gps_data)★ 에 올린다.
 *   "CSV 는 브라우저 밖으로 나가지 않는다" 의 유일한 예외다 — 올린 파일·링크로 받은 CSV·
 *   GitHub 에서 받은 CSV 는 여전히 어디에도 보내지 않는다.
 *   - 토큰은 ★저장하는 사람이 그때 붙여 넣는다★. 번들에 넣지 말 것 — 정적 사이트 번들은
 *     누구나 꺼내 볼 수 있다.
 *   - 토큰은 ★이 탭의 메모리에만★ 둔다(아래 sessionToken). 쿠키·localStorage·
 *     sessionStorage 에 남기지 않는다 — 개인정보처리방침이 그것들을 쓰지 않는다고 적고
 *     있고, 같은 페이지에서 광고 스크립트가 돌기 때문이다(저장소는 그 스크립트도 읽는다).
 *
 * CORS : api.github.com·raw.githubusercontent.com 둘 다 `Access-Control-Allow-Origin: *`
 *   를 준다. 그래서 프록시 없이 브라우저에서 곧바로 부를 수 있다(2026-09-14 확인).
 *   쓰기(PUT)는 Authorization·Content-Type 때문에 사전 요청(preflight)이 붙는데, GitHub 이
 *   그 둘을 허용한다. ★X-GitHub-Api-Version 은 보내지 않는다★ — 허용 헤더 목록에 없으면
 *   사전 요청에서 막힌다(값을 안 주면 서버가 기본 버전을 쓴다).
 */

const OWNER = "cheongbaek";

/**
 * ★본선 코스 — 목록 맨 위에 고정한다★ [2026-09-30] 이름에 시각이 없어 최신순 정렬에서
 * 맨 뒤로 밀리는데, 가장 자주 여는 파일이다. 차량 prompt 도 같은 파일을 맨 위에 둔다
 * (이름의 소유자는 gold 저장소 white1/traffic_timer.py 의 MAINCOURSE_FILE).
 */
export const PINNED_ROUTE = "maincourse.csv";

/** 목록을 받아 올 폴더. ★리포까지 폴더마다 따로 든다★ — 단순 기록은 차량 리포(gold)가
 *  아니라 이 앱의 리포(find_wc)에 있다. */
export interface GithubSource {
  key: string;
  /** 화면에 쓰는 이름 — 경로가 아니라 '무엇이 들었는지' 를 적는다 */
  label: string;
  hint: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

/**
 * ★단순 기록★ [2026-10-08] — 이 앱 리포의 gps_data 폴더.
 * 'GitHub 에 저장' 이 쓰는 곳도 ★여기 하나★ 다(쓰는 곳과 읽는 곳이 같은 객체를 본다).
 * 이 폴더에 CSV 를 올리는 커밋은 사이트를 다시 배포하지 않는다 —
 * .github/workflows/deploy-pages.yml 의 paths-ignore 가 거른다.
 */
export const SIMPLE_SOURCE: GithubSource = {
  key: "simple",
  label: "단순 기록",
  hint: "find_wc/gps_data · 'GitHub 에 저장' 한 궤적과 직접 올린 CSV",
  owner: OWNER,
  repo: "find_wc",
  ref: "main",
  path: "gps_data",
};

export const GITHUB_SOURCES: GithubSource[] = [
  {
    key: "gps_data",
    label: "매핑 경로",
    hint: "gps_data · 차가 따라갈 경로(latitude/longitude)",
    owner: OWNER,
    repo: "gold",
    ref: "main",
    path: "gold_ws/src/white1/gps_data",
  },
  {
    key: "ros2bag",
    label: "주행 기록",
    hint: "ros2bag · 실제로 달린 기록(fix_lat/fix_lon)",
    owner: OWNER,
    repo: "gold",
    ref: "main",
    path: "gold_ws/src/white1/ros2bag",
  },
  SIMPLE_SOURCE,
];

export interface GhFile {
  name: string;
  path: string;
  /** 바이트. 목록 응답이 그대로 준다 — 고르기 전에 용량을 보여 주려고 쓴다 */
  size: number;
  downloadUrl: string;
  /** 파일명에 박힌 시각(YYYYMMDD_HHMMSS)을 파싱한 것. 없으면 null */
  stamp: string | null;
}

export function folderUrl(source: GithubSource): string {
  return `https://github.com/${source.owner}/${source.repo}/tree/${source.ref}/${source.path}`;
}

/** contents API 주소. 경로는 조각마다 인코딩한다(폴더 구분 '/' 는 살린다) */
function contentsUrl(source: GithubSource, sub = ""): string {
  const path = sub ? `${source.path}/${sub}` : source.path;
  return (
    `https://api.github.com/repos/${source.owner}/${source.repo}/contents/` +
    path.split("/").map(encodeURIComponent).join("/")
  );
}

/**
 * ★이 탭에서 방금 저장한 파일★ — 소스 key 별로 든다.
 * 익명 목록 응답은 GitHub 쪽 캐시(최대 60 s)를 타서, 저장 직후 '단순 기록' 을 열면
 * 새 파일이 아직 안 보일 수 있다. 저장 응답이 이미 그 파일의 정보를 주므로 목록에
 * 직접 끼워 넣는다. 탭을 닫으면 사라진다(그때쯤이면 목록 응답이 따라잡았다).
 */
const savedThisTab = new Map<string, GhFile[]>();

function rememberSaved(source: GithubSource, file: GhFile): void {
  const list = (savedThisTab.get(source.key) ?? []).filter((f) => f.path !== file.path);
  list.push(file);
  savedThisTab.set(source.key, list);
}

/**
 * 파일명 안의 시각을 꺼낸다.
 *   route_20260913_161721.csv                                → 2026-09-13 16:17
 *   manual-20260814_132123.csv                               → 2026-08-14 13:21
 *   goal_37.2390089_126.7753927-20260913_104456.csv          → 2026-09-13 10:44
 * ★마지막 것을 쓴다★ goal 파일명에는 좌표의 숫자가 먼저 나와서, 첫 번째를 집으면
 *   엉뚱한 자리를 시각으로 읽는다.
 */
function parseStamp(name: string): string | null {
  const all = [...name.matchAll(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

interface ContentsEntry {
  name?: unknown;
  path?: unknown;
  size?: unknown;
  type?: unknown;
  download_url?: unknown;
  html_url?: unknown;
}

/** 목록 응답의 한 줄과 저장 응답의 content 가 ★같은 모양★ 이라 한 곳에서 읽는다.
 *  CSV 가 아니거나 내려받을 주소가 없으면 null — 폴더 안의 README.md 같은 것이 그렇다. */
function toGhFile(raw: ContentsEntry | null | undefined): GhFile | null {
  if (raw?.type !== "file") return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  const downloadUrl = typeof raw.download_url === "string" ? raw.download_url : "";
  if (!/\.csv$/i.test(name) || !downloadUrl) return null;
  return {
    name,
    path: typeof raw.path === "string" ? raw.path : name,
    size: typeof raw.size === "number" ? raw.size : 0,
    downloadUrl,
    stamp: parseStamp(name),
  };
}

/**
 * 한 폴더의 CSV 목록. 최신이 위로 오게 정렬한다 — 118개가 들어 있는 폴더에서
 * 사전순은 아무 도움이 안 되고, 사람이 찾는 것은 대개 ★방금 딴 것★ 이다.
 * 시각을 못 읽은 파일은 뒤로 보내되 서로는 이름순으로 둔다.
 */
export async function listGithubCsv(source: GithubSource): Promise<GhFile[]> {
  const url = `${contentsUrl(source)}?ref=${encodeURIComponent(source.ref)}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new Error("GitHub 에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
  }

  if (res.status === 403 || res.status === 429) {
    // 익명 한도(시간당 60회)에 걸린 경우가 대부분이다. 사람이 원인을 알 수 있게 적는다.
    throw new Error(
      "GitHub 요청 한도에 걸렸습니다(익명 호출은 시간당 60회). " +
        "잠시 뒤 다시 시도하거나, 파일을 직접 내려받아 올려 주세요."
    );
  }
  if (res.status === 404) {
    throw new Error(`폴더를 찾지 못했습니다: ${source.path}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub 응답 오류 ${res.status}`);
  }

  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("폴더가 아니라 파일을 가리키고 있습니다.");
  }

  let files: GhFile[] = [];
  for (const raw of body as ContentsEntry[]) {
    const f = toGhFile(raw);
    if (f) files.push(f);
  }

  // 방금 저장한 것은 응답보다 이쪽이 최신이다 — 같은 경로면 갈아 끼운다(덮어쓰기)
  for (const saved of savedThisTab.get(source.key) ?? []) {
    files = files.filter((f) => f.path !== saved.path);
    files.push(saved);
  }

  files.sort((a, b) => {
    if (a.name === PINNED_ROUTE || b.name === PINNED_ROUTE) {
      return a.name === PINNED_ROUTE ? -1 : 1;
    }
    if (a.stamp && b.stamp) return a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0;
    if (a.stamp) return -1;
    if (b.stamp) return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

/** 동시에 열어 둘 연결 수. 한 번에 다 부르면 브라우저가 알아서 줄 세우지만,
 *  진행률이 끝에 몰려 '멈춘 것처럼' 보인다. 4개면 체감이 매끄럽다. */
const FETCH_POOL = 4;

export interface DownloadResult {
  files: File[];
  errors: string[];
}

/**
 * 고른 파일들을 받아 ★File 로 감싼다★ — 손으로 올린 파일과 ★완전히 같은 경로★
 * (App 의 addFiles)를 타게 하기 위함이다. 유형 판별·색 배정·통계가 갈리지 않는다.
 * inbound.ts 가 링크로 받은 CSV 를 다루는 방식과 같다.
 *
 * ★하나가 실패해도 나머지는 올린다★ 118개 중 하나가 깨졌다고 전부 버리면,
 *   사람은 무엇이 문제였는지도 모른 채 다시 처음부터 골라야 한다.
 */
export async function downloadGithubCsv(
  picks: GhFile[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const files: File[] = [];
  const errors: string[] = [];
  let done = 0;

  const queue = [...picks];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const res = await fetch(item.downloadUrl, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        files.push(new File([text], item.name, { type: "text/csv" }));
      } catch (e) {
        if (signal?.aborted) return;
        errors.push(`${item.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done++;
      onProgress?.(done, picks.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FETCH_POOL, picks.length) }, () => worker())
  );
  return { files, errors };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ══════════════════════════════════════════════════════════════════════════
//  쓰기 — 'GitHub 에 저장' [2026-10-08]   (머리말의 ★쓰기★ 절 참고)
// ══════════════════════════════════════════════════════════════════════════

/** ★이 탭의 메모리에만★ 둔다. 새로고침하면 사라진다(머리말 참고 — 저장소에 남기지 않는다). */
let sessionToken: string | null = null;

export function getSessionToken(): string | null {
  return sessionToken;
}

export function setSessionToken(token: string | null): void {
  const t = token?.trim();
  sessionToken = t ? t : null;
}

/** 화면에는 앞 몇 글자와 끝 4자리만 — 붙여 넣은 것이 그 토큰인지 알아볼 만큼만 */
export function maskToken(token: string): string {
  if (token.length <= 12) return "…" + token.slice(-4);
  return `${token.slice(0, token.startsWith("github_pat_") ? 11 : 4)}…${token.slice(-4)}`;
}

/**
 * 토큰 만들기 주소. GitHub 의 fine-grained 토큰 '템플릿 URL'(2025-08 도입)로 이름·소유자·
 * 기한·Contents 쓰기 권한을 미리 채운다. ★저장할 리포는 채울 수 없다★ — 화면이
 * 'Only select repositories → cheongbaek/find_wc' 를 직접 고르라고 안내한다.
 */
export const TOKEN_NEW_URL =
  "https://github.com/settings/personal-access-tokens/new" +
  "?name=find_wc-gps_data" +
  "&description=" +
  encodeURIComponent("Save routes drawn on cheongbaek.github.io/find_wc to find_wc/gps_data") +
  `&target_name=${OWNER}&expires_in=90&contents=write`;

/** 저장 파일 이름 — 폴더 밖으로 나가거나(../) 이상한 경로가 되지 않게 좁게 받는다 */
export const SAVE_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,95}\.csv$/;

export type SaveErrorKind =
  | "auth"        // 401 — 토큰이 틀렸거나 기한이 지났다 → 토큰을 다시 받는다
  | "forbidden"   // 403 — 토큰은 맞는데 그 리포에 쓸 권한이 없다
  | "notfound"    // 404 — 토큰이 그 리포를 못 본다
  | "exists"      // 422 — 같은 이름이 있다 → 덮어쓸지 사람이 정한다
  | "conflict"    // 409 — 그 사이에 리포가 바뀌었다
  | "network"
  | "other";

export class GithubSaveError extends Error {
  readonly kind: SaveErrorKind;
  constructor(kind: SaveErrorKind, message: string) {
    super(message);
    this.name = "GithubSaveError";
    this.kind = kind;
  }
}

export interface SaveResult {
  /** 단순 기록 목록에 그대로 끼워 넣을 수 있는 항목 */
  file: GhFile;
  /** GitHub 에서 그 파일 보기 */
  htmlUrl: string;
  /** 만들어진 커밋 보기 (응답에 없으면 null) */
  commitUrl: string | null;
}

/** UTF-8 바이트를 base64 로. btoa 는 Latin-1 만 받으므로 바이트를 한 번 거친다 */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function authHeaders(token: string): Record<string, string> {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function httpError(status: number, body: Record<string, unknown>): GithubSaveError {
  const msg = typeof body.message === "string" ? body.message : "";
  switch (status) {
    case 401:
      return new GithubSaveError("auth", "토큰이 틀렸거나 기한이 지났습니다. 새 토큰을 넣어 주세요.");
    case 403:
      return new GithubSaveError(
        "forbidden",
        "이 토큰으로는 저장할 수 없습니다 — Repository access 에 cheongbaek/find_wc 가 있고 " +
          "Contents 권한이 Read and write 인지 확인해 주세요." +
          (msg ? ` (${msg})` : "")
      );
    case 404:
      return new GithubSaveError(
        "notfound",
        "리포를 찾지 못했습니다 — 토큰의 Repository access 에 cheongbaek/find_wc 가 들어 있는지 확인해 주세요."
      );
    case 409:
      return new GithubSaveError("conflict", "그 사이에 리포가 바뀌었습니다. 다시 저장해 주세요.");
    case 422:
      // sha 없이 같은 경로에 쓰면 이 응답이 온다. 다른 검증 오류는 그대로 보여 준다.
      if (/sha/i.test(msg)) {
        return new GithubSaveError("exists", "같은 이름의 파일이 이미 있습니다.");
      }
      return new GithubSaveError("other", `GitHub 이 요청을 거절했습니다${msg ? ` — ${msg}` : ""}`);
    default:
      return new GithubSaveError("other", `GitHub 응답 오류 ${status}${msg ? ` — ${msg}` : ""}`);
  }
}

/** 이미 있는 파일의 sha — 덮어쓸 때만 필요하다. 없으면 null.
 *  ★캐시를 쓰지 않는다★ 묵은 sha 를 내면 409 로 실패한다. */
async function existingSha(source: GithubSource, name: string, token: string): Promise<string | null> {
  const res = await fetch(`${contentsUrl(source, name)}?ref=${encodeURIComponent(source.ref)}`, {
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  const body = await readJson(res);
  if (!res.ok) throw httpError(res.status, body);
  return typeof body.sha === "string" ? body.sha : null;
}

/**
 * ★단순 기록 폴더★(SIMPLE_SOURCE)에 CSV 한 개를 올린다 — contents API, 커밋 하나.
 *
 * overwrite 가 false 면 같은 이름이 있을 때 'exists' 로 실패한다. 덮어쓸지는 사람이
 * 정한다(조용히 덮지 않는다). 성공하면 그 파일을 이 탭의 목록 캐시에 넣어, 바로 '단순
 * 기록' 을 열어도 보이게 한다(rememberSaved).
 */
export async function saveGithubCsv(
  name: string,
  text: string,
  message: string,
  token: string,
  { overwrite = false }: { overwrite?: boolean } = {}
): Promise<SaveResult> {
  const source = SIMPLE_SOURCE;
  if (!SAVE_NAME_RE.test(name)) {
    throw new GithubSaveError("other", "파일 이름은 영문·숫자·. _ - 로 쓰고 .csv 로 끝나야 합니다.");
  }
  try {
    const sha = overwrite ? await existingSha(source, name, token) : null;
    const res = await fetch(contentsUrl(source, name), {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: base64Utf8(text),
        branch: source.ref,
        ...(sha ? { sha } : {}),
      }),
    });
    const body = await readJson(res);
    if (!res.ok) throw httpError(res.status, body);

    const content = (body.content ?? null) as ContentsEntry | null;
    const path = `${source.path}/${name}`;
    const file: GhFile = toGhFile(content) ?? {
      name,
      path,
      size: new TextEncoder().encode(text).length,
      downloadUrl: `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${path}`,
      stamp: parseStamp(name),
    };
    rememberSaved(source, file);

    const commit = (body.commit ?? null) as { html_url?: unknown } | null;
    return {
      file,
      htmlUrl:
        typeof content?.html_url === "string"
          ? content.html_url
          : `https://github.com/${source.owner}/${source.repo}/blob/${source.ref}/${path}`,
      commitUrl: typeof commit?.html_url === "string" ? commit.html_url : null,
    };
  } catch (e) {
    if (e instanceof GithubSaveError) throw e;
    throw new GithubSaveError("network", "GitHub 에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
  }
}
