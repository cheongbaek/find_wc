// 위경도 ↔ 국소평면 변환과 궤적 오차 계산.
//
// 왜 위경도를 그대로 안 쓰나: 이 위도에서 경도 1°는 위도 1°보다 짧다(약 0.8배).
// 위경도 차이를 그대로 거리로 쓰면 동서 방향이 부풀어 오차가 왜곡된다. 그래서
// mapping.py / driving.py 가 쓰는 것과 같은 국소평면 근사로 미터로 바꾼 뒤 계산한다.
//   x = R·Δlon·cos(lat0)  [동쪽+]      y = R·Δlat  [북쪽+]

export const EARTH_R = 6378137.0;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface XY {
  x: number;
  y: number;
}

/** 위경도 목록 → 원점 기준 국소평면 [m] */
export function toLocal(pts: LatLng[], origin: LatLng): XY[] {
  const c = Math.cos((origin.lat * Math.PI) / 180);
  return pts.map((p) => ({
    x: EARTH_R * ((p.lng - origin.lng) * Math.PI / 180) * c,
    y: EARTH_R * ((p.lat - origin.lat) * Math.PI / 180),
  }));
}

/** 두 위경도 사이 거리 [m]. 수백 m 규모라 국소평면 근사로 충분하다. */
export function distMeters(a: LatLng, b: LatLng): number {
  const c = Math.cos((a.lat * Math.PI) / 180);
  const dx = EARTH_R * ((b.lng - a.lng) * Math.PI / 180) * c;
  const dy = EARTH_R * ((b.lat - a.lat) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/** 궤적 총 길이 [m] */
export function pathLength(xy: XY[]): number {
  let sum = 0;
  for (let i = 1; i < xy.length; i++) {
    sum += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
  }
  return sum;
}

/** 각 점까지의 누적 거리 [m] — 오차 그래프의 가로축이 된다 */
export function cumulative(xy: XY[]): number[] {
  const out = new Array<number>(xy.length);
  let sum = 0;
  out[0] = 0;
  for (let i = 1; i < xy.length; i++) {
    sum += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
    out[i] = sum;
  }
  return out;
}

/** 점 p 에서 선분 a-b 까지의 최단거리 [m] */
function pointSegDist(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const den = abx * abx + aby * aby;
  if (den < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / den;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

const WINDOW = 60; // 창 탐색 반경(세그먼트 개수)

/**
 * 주행 궤적의 각 점에서 ★매핑 폴리라인★ 까지의 최단거리 [m].
 * "얼마나 벗어나 달렸나" 의 숫자 근거다.
 *
 * 두 궤적은 순서가 대체로 같이 흐르므로 직전에 찾은 세그먼트 주변만 본다.
 * 창 가장자리가 최소로 나오면(= 궤적이 건너뛰었을 수 있다) 그때만 전체를 훑어
 * 정확도를 지킨다. 덕분에 점이 수만 개여도 즉시 끝난다.
 */
export function crossTrack(recXY: XY[], mapXY: XY[]): number[] {
  const n = mapXY.length;
  if (n < 2) return recXY.map(() => 0);

  const scan = (p: XY, from: number, to: number) => {
    let best = Infinity;
    let bestIdx = from;
    for (let i = Math.max(1, from); i <= Math.min(n - 1, to); i++) {
      const d = pointSegDist(p, mapXY[i - 1], mapXY[i]);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    return { best, bestIdx };
  };

  const out = new Array<number>(recXY.length);
  let anchor = -1;
  for (let k = 0; k < recXY.length; k++) {
    const p = recXY[k];
    let found = anchor < 0 ? scan(p, 1, n - 1) : scan(p, anchor - WINDOW, anchor + WINDOW);
    if (anchor >= 0 && Math.abs(found.bestIdx - anchor) >= WINDOW) {
      found = scan(p, 1, n - 1); // 창 끝에 붙었다 = 창 밖이 더 가까울 수 있다
    }
    anchor = found.bestIdx;
    out[k] = found.best;
  }
  return out;
}

export interface Quantiles {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export function quantiles(values: number[]): Quantiles | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
  };
}

/**
 * 오차 → 색. 0 m 이면 초록, errMax 이상이면 빨강.
 * 색상환에서 130°(초록) → 0°(빨강) 로 미끄러뜨린다.
 */
export function errColor(err: number, errMax: number): string {
  const t = Math.max(0, Math.min(1, err / Math.max(errMax, 1e-6)));
  return `hsl(${Math.round(130 * (1 - t))} 85% 48%)`;
}
