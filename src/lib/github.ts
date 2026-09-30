/**
 * github.ts — cheongbaek/gold 리포에 올라와 있는 CSV 를 목록으로 받아 내려받는다.
 *
 * ★"CSV 는 브라우저 밖으로 나가지 않는다" 원칙과 어긋나지 않는다★
 *   그 원칙은 ★사용자의 파일을 밖으로 보내지 말라★ 는 것이다. 여기는 반대 방향으로,
 *   이미 공개된 리포의 파일을 ★받아 오기만★ 한다. 올리는 경로는 없고 앞으로도 없다.
 *
 * ★토큰을 쓰지 않는다★ 공개 리포라 익명 요청으로 읽힌다. 토큰을 넣으면 정적 사이트
 *   번들에 그대로 박혀 누구나 꺼내 쓸 수 있으므로 ★넣지 말 것★.
 *   대신 익명 한도(IP 당 시간당 60회)가 있다 — 그래서 목록은 한 번 받아 캐시하고,
 *   내려받기는 raw.githubusercontent.com 을 쓴다(그쪽은 이 한도와 별개다).
 *
 * CORS : api.github.com·raw.githubusercontent.com 둘 다 `Access-Control-Allow-Origin: *`
 *   를 준다. 그래서 프록시 없이 브라우저에서 곧바로 부를 수 있다(2026-09-14 확인).
 */

const OWNER = "cheongbaek";
const REPO = "gold";
const REF = "main";

/**
 * ★본선 코스 — 목록 맨 위에 고정한다★ [2026-09-30] 이름에 시각이 없어 최신순 정렬에서
 * 맨 뒤로 밀리는데, 가장 자주 여는 파일이다. 차량 prompt 도 같은 파일을 맨 위에 둔다
 * (이름의 소유자는 gold 저장소 white1/traffic_timer.py 의 MAINCOURSE_FILE).
 */
export const PINNED_ROUTE = "maincourse.csv";

/** 목록을 받아 올 폴더. ★앱의 두 궤적 유형과 1:1로 맞아떨어진다★ */
export interface GithubSource {
  key: string;
  /** 화면에 쓰는 이름 — 경로가 아니라 '무엇이 들었는지' 를 적는다 */
  label: string;
  hint: string;
  path: string;
}

export const GITHUB_SOURCES: GithubSource[] = [
  {
    key: "gps_data",
    label: "매핑 경로",
    hint: "gps_data · 차가 따라갈 경로(latitude/longitude)",
    path: "gold_ws/src/white1/gps_data",
  },
  {
    key: "ros2bag",
    label: "주행 기록",
    hint: "ros2bag · 실제로 달린 기록(fix_lat/fix_lon)",
    path: "gold_ws/src/white1/ros2bag",
  },
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
  return `https://github.com/${OWNER}/${REPO}/tree/${REF}/${source.path}`;
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
}

/**
 * 한 폴더의 CSV 목록. 최신이 위로 오게 정렬한다 — 118개가 들어 있는 폴더에서
 * 사전순은 아무 도움이 안 되고, 사람이 찾는 것은 대개 ★방금 딴 것★ 이다.
 * 시각을 못 읽은 파일은 뒤로 보내되 서로는 이름순으로 둔다.
 */
export async function listGithubCsv(source: GithubSource): Promise<GhFile[]> {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/` +
    `${source.path.split("/").map(encodeURIComponent).join("/")}?ref=${REF}`;

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

  const files: GhFile[] = [];
  for (const raw of body as ContentsEntry[]) {
    if (raw?.type !== "file") continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    const downloadUrl = typeof raw.download_url === "string" ? raw.download_url : "";
    if (!/\.csv$/i.test(name) || !downloadUrl) continue;
    files.push({
      name,
      path: typeof raw.path === "string" ? raw.path : name,
      size: typeof raw.size === "number" ? raw.size : 0,
      downloadUrl,
      stamp: parseStamp(name),
    });
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
