// 궤적 생성 — 지도를 클릭해 매핑 CSV 를 손으로 만든다.
//
// ★왜 필요한가★ mapping.py 는 사람이 차를 몰고 다녀야 경로가 나온다. 코스를 바꿔
// 보거나 아직 못 가 본 곳을 미리 그려 보려면 그 한 바퀴를 매번 돌아야 한다. 위성
// 영상 위에 클릭으로 같은 형식의 CSV 를 만들 수 있으면 그 왕복이 사라진다.
//
// ★격자에 물린다★ mapping.py 는 ★일정 거리마다 한 점★ 을 남긴다(SPACING_M 0.25).
// 손으로 찍는 점도 같은 규칙을 따라야 driving 의 경로 로더와 곡률 계산이 같은 밀도의
// 입력을 받는다. 그래서 클릭 지점을 ★직전 점에서 간격의 정수배★ 로 당겨 붙이고,
// 그 사이를 같은 간격으로 채운다. 지도 최대 배율에서도 0.25 m 를 손으로 겨눌 수는
// 없으므로(실제로는 2~3 m 단위로 찍힌다) 이 보간이 사실상 점을 다 만든다.
//
// ⚠️ 보간은 ★직선뿐★ 이다. 곡선 구간을 부드럽게 만드는 후처리는 여기서 하지 않는다 —
//   클릭을 촘촘히 하면 그만큼 꺾인 선이 된다. 그게 보이는 대로다.

import { EARTH_R, type LatLng } from "./geo";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** mapping.py 의 SPACING_M 기본값 */
export const DEFAULT_SPACING_M = 0.25;

/** 한 번에 이어 붙일 수 있는 최대 점 수 — 오클릭으로 수십 km 를 채우는 것을 막는다 */
const MAX_STEPS_PER_CLICK = 4000;

/** 원점 근처의 국소평면 변환 계수. 수백 m 규모라 이 근사로 충분하다 */
function frame(origin: LatLng) {
  const c = Math.cos(origin.lat * D2R);
  return {
    /** 위경도 → 원점 기준 [m] */
    to: (p: LatLng) => ({
      x: EARTH_R * (p.lng - origin.lng) * D2R * c,
      y: EARTH_R * (p.lat - origin.lat) * D2R,
    }),
    /** 원점 기준 [m] → 위경도 */
    from: (x: number, y: number): LatLng => ({
      lat: origin.lat + (y / EARTH_R) * R2D,
      lng: origin.lng + (x / (EARTH_R * c)) * R2D,
    }),
  };
}

export interface Snap {
  /** 격자에 물린 지점 — 실제로 찍히는 자리 */
  at: LatLng;
  /** 직전 점에서 몇 칸 떨어졌나 (1 이상) */
  steps: number;
  /** 그 거리 [m] = steps × spacing */
  distM: number;
  /** 클릭 지점이 격자에서 얼마나 당겨졌나 [m] — 커서와 예정 지점의 간격 */
  pullM: number;
}

/**
 * 클릭 지점을 ★직전 점 기준 간격의 정수배★ 로 당겨 붙인다.
 *
 * 방향은 클릭한 그대로 두고 거리만 반올림한다 — 방향까지 격자에 물리면 대각선을
 * 그을 수 없게 된다. 0 칸은 허용하지 않는다(같은 자리에 두 번 찍히면 경로가 아니라
 * 점 뭉치가 된다 — mapping.py 가 hold 를 걸러내는 것과 같은 이유다).
 */
export function snapToGrid(last: LatLng, raw: LatLng, spacing: number): Snap {
  const f = frame(last);
  const { x, y } = f.to(raw);
  const d = Math.hypot(x, y);
  if (d < 1e-9) {
    // 직전 점과 같은 자리 — 한 칸 동쪽으로 밀어 둔다(정지 상태를 못 만들게)
    return { at: f.from(spacing, 0), steps: 1, distM: spacing, pullM: spacing };
  }
  const steps = Math.min(MAX_STEPS_PER_CLICK, Math.max(1, Math.round(d / spacing)));
  const target = steps * spacing;
  const k = target / d;
  return {
    at: f.from(x * k, y * k),
    steps,
    distM: target,
    pullM: Math.abs(target - d),
  };
}

/**
 * 두 점 사이를 간격대로 채운다. ★직전 점은 넣지 않고 그 다음 칸부터★ 돌려준다 —
 * 부르는 쪽이 이미 갖고 있는 점을 두 번 넣지 않게 하기 위해서다.
 */
export function interpolate(last: LatLng, to: LatLng, steps: number): LatLng[] {
  const f = frame(last);
  const { x, y } = f.to(to);
  const out: LatLng[] = [];
  for (let k = 1; k <= steps; k++) out.push(f.from((x * k) / steps, (y * k) / steps));
  return out;
}

/** 클릭 한 번의 결과 — 붙일 점들과 그 요약 */
export interface DrawSegment {
  pts: LatLng[];
  snap: Snap;
}

export function extend(last: LatLng, raw: LatLng, spacing: number): DrawSegment {
  const snap = snapToGrid(last, raw, spacing);
  return { pts: interpolate(last, snap.at, snap.steps), snap };
}

/** 궤적 총 길이 [m] */
export function totalLength(pts: LatLng[]): number {
  const f = frame(pts[0] ?? { lat: 0, lng: 0 });
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = f.to(pts[i - 1]);
    const b = f.to(pts[i]);
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/**
 * mapping.py 의 CSV 와 ★같은 열 순서★ 로 쓴다.
 *
 * driving.py 의 경로 로더는 latitude/longitude 만 읽으므로 나머지는 호환을 위한
 * 자리다. heading 은 궤적 모양에서 실제로 나오는 값이라 채운다(mapping.py 와 같은
 * 규약 — 0° 가 동쪽, 반시계 +). ★실계측 열은 비워 둔다★ — 0 을 적으면 '측정했더니
 * 0 이었다'로 읽히지만 이 파일에는 측정 자체가 없다. 빈 칸이 그 사실을 그대로 말한다.
 */
export function toMappingCsv(pts: LatLng[]): string {
  const header = [
    "latitude", "longitude", "heading", "speed", "steer",
    "direction", "pitch", "terrain",
    "throttle_pulse", "wheel_pulse", "wheel_speed",
    "steer_measured", "throttle_raw", "auto_mode", "estop",
  ];
  const f = frame(pts[0] ?? { lat: 0, lng: 0 });
  const xy = pts.map(f.to);

  const lines = [header.join(",")];
  for (let i = 0; i < pts.length; i++) {
    // 진행 방위는 다음 점을 향한다. 마지막 점만 직전 방위를 그대로 쓴다.
    const a = xy[Math.min(i, xy.length - 2)];
    const b = xy[Math.min(i + 1, xy.length - 1)];
    const heading = xy.length < 2 ? 0 : Math.atan2(b.y - a.y, b.x - a.x) * R2D;
    lines.push(
      [
        pts[i].lat.toFixed(8), pts[i].lng.toFixed(8), heading.toFixed(2),
        "0.000", "0", "1", "0.00", "0",
        "", "", "", "", "", "", "",
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * 파일 이름. ★route_ 로 시작해야 차량이 목록에 띄운다★ —
 * white1/prompt.py 는 `f.startswith('route_') and f.endswith('.csv')` 로 거른다.
 */
export function routeFileName(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `route_${stamp}.csv`;
}

/**
 * 파일로 내려받는다.
 * ★브라우저 밖으로 나가지 않는다★ — Blob 은 이 탭 안에서 만들어져 사용자 디스크로
 * 바로 간다. 어디에도 올리지 않는다(이 앱의 CSV 원칙과 같다).
 */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 지우면 사파리에서 저장이 취소되는 일이 있어 한 틱 뒤로 미룬다
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
