// CSV 읽기 + ★파일 유형 자동 판별★ + ★RTK 여부 판정★
//
// 두 가지 CSV 를 받는다. 사용자가 어느 쪽인지 고를 필요 없이 ★열 이름을 보고★ 정한다.
//   · 매핑 CSV (mapping.py 산출물, gps_data/route_*.csv) : latitude, longitude
//   · 주행 기록 CSV (record.py 산출물, ros2bag/*.csv)     : fix_lat, fix_lon (/fix 원값)
// 둘 다 아니면 lat/lon 비슷한 열을 마지막으로 한 번 더 찾아보고, 그래도 없으면 거절한다.

import type { LatLng } from "./geo";

export type TrackKind = "mapping" | "record" | "unknown";

/** 열 이름 후보 — 앞에 있는 것부터 찾는다(소문자로 비교) */
const MAPPING_LAT = "latitude";
const MAPPING_LON = "longitude";
const RECORD_LAT = "fix_lat";
const RECORD_LON = "fix_lon";
const FALLBACK_LAT = ["lat", "gps_lat", "ego_lat"];
const FALLBACK_LON = ["lon", "lng", "gps_lon", "ego_lon"];

/** 있으면 같이 실어 두는 부가 정보 — 툴팁과 오차 그래프에 쓴다 */
const EXTRA_COLUMNS = {
  t: ["t_rel", "time", "timestamp"],
  speed: ["speed_kmh", "speed"],
  cte: ["cte_m", "cte"],
  heading: ["heading", "ego_heading_deg"],
  sigma: ["gps_sigma_m"],
  cov: ["fix_cov_xx"],
} as const;

export type ExtraName = keyof typeof EXTRA_COLUMNS;
export type Extras = Partial<Record<ExtraName, (number | null)[]>>;

/**
 * ★제어 진단 열★ — record.py 가 20 Hz 로 찍는 신호들. 위 EXTRA_COLUMNS 와 따로 두는
 * 이유는 ★해상도가 다르기 때문★ 이다(아래 ControlSeries 주석).
 *
 * 이름의 뜻은 white1/record.py 의 RECORD_TOPICS 가 소유한다. 헷갈리기 쉬운 것만:
 *  · cmd_steer_deg / steer_measured_deg 는 ★pot 지령각★ 이지 도로휠각이 아니다
 *    (도로휠각 ≈ pot ÷ 1.26). driving.py 의 '조향 전달계 실측 보정' 절 참고.
 *  · heading_err_deg 는 ★헤딩 오차가 아니다★ — 순수추종 목표점의 차체기준 방위 α다
 *    (driving.py:2836 "예전엔 인덱스 WP 방위오차, 지금은 alpha").
 *  · speed_kmh(/speed) 는 record.py 가 "절대값은 못 믿는다"고 못 박은 IMU 적분값이라
 *    여기 넣지 않는다. 속도는 gps_kmh 와 encoder_sum 으로 본다.
 */
const CONTROL_COLUMNS = {
  // ── /cmd_vel_raw : 아두이노로 나가는 최종 명령 ──
  cmdPulse: ["cmd_pulse"],
  cmdSteer: ["cmd_steer_deg"],
  // ── 조향 실측 ──
  measSteer: ["steer_measured_deg", "steer_measured"],
  // ── 순수추종 입력 ──
  alpha: ["heading_err_deg"],
  targetDist: ["target_dist_m"],
  // ── CTE 적분(PID 의 I 항) ──
  cte: ["cte_m"],
  cteITerm: ["cte_i_term_deg"],
  cteIntegral: ["cte_integral"],
  // ── 속도 ──
  gpsKmh: ["gps_kmh"],
  encoder: ["encoder_sum"],
  // ── 저속 펄스 보정 3종 : out ≠ ref 인 구간이 보정이 걸린 구간이다 ──
  refPulse: ["ref_pulse"],
  outPulse: ["out_pulse"],
  measPulse: ["meas_pulse"],
  // ── 문맥 : 속도 그래프의 계단이 왜 생겼는지 ──
  goalPhase: ["goal_phase"],
  cbState: ["cb_state"],
  brakeLevel: ["brake_level"],
  brakePot: ["brake_pot"],
  // ── 이 좌표를 얼마나 믿을 수 있나 ──
  isRaw: ["gps_is_raw"],
  rejectN: ["gps_reject_n"],
  sigma: ["gps_sigma_m"],
} as const;

export type ControlName = keyof typeof CONTROL_COLUMNS;

/**
 * ★전 행 시계열★ — hold 중복을 합치기 ★전★ 의 원본 해상도.
 *
 * 위의 pts/extras 는 연속 중복 좌표를 하나로 합친다(오차 통계가 왜곡되지 않게).
 * 그런데 GPS 는 5 Hz 이고 제어는 20 Hz 라, 같은 규칙을 제어 신호에 적용하면
 * ★네 표본 중 셋이 사라진다★ — 조향이 20 Hz 로 움직이는 것을 5 Hz 로 보게 된다.
 * 그래서 제어 신호만은 병합하지 않은 전 행을 따로 들고 있는다.
 *
 * ⚠️ record.py 는 값이 안 오면 ★마지막 값을 유지(hold)★ 한다. 즉 여기 있는 값은
 *   "그 시각의 측정값"이 아니라 "그 시각까지 마지막으로 받은 값"이다. 5 Hz 토픽
 *   (gps_kmh 등)은 같은 값이 네 번씩 이어진다 — 계단으로 보이는 것이 정상이다.
 */
export interface ControlSeries {
  /** t_rel [s]. 기록 시작부터의 경과 */
  t: number[];
  cols: Partial<Record<ControlName, (number | null)[]>>;
  /** 실제로 찾은 열 이름 — 무엇을 읽었는지 감추지 않는다 */
  found: string[];
  /** 표본 간 중앙값 간격 [s]. 20 Hz 면 0.05 가 나와야 한다 */
  periodS: number | null;
}

/**
 * ★GPS 정밀도 등급★ — 밝기로 표현한다. 높을수록 밝다.
 *
 * 이진(RTK냐 아니냐)으로는 실측 파일들의 차이가 드러나지 않았다. 어떤 주행은
 * σ 가 1.1 cm(RTK 고정)와 2.2 m 사이를 오갔고, 다른 주행은 전 구간 5~15 cm 였다.
 * 후자를 "RTK 아님" 한 덩어리로 칠하면 정작 볼 것이 사라진다.
 */
export type Quality = "high" | "mid" | "low";

/** 등급 경계 [m] — RTK 고정은 보통 1~3 cm, Float·DGPS 는 10 cm~1 m 다 */
export const SIGMA_HIGH = 0.05;
export const SIGMA_MID = 0.3;

export const QUALITY_LABEL: Record<Quality, string> = {
  high: `RTK 고정급 (σ ≤ ${SIGMA_HIGH * 100} cm)`,
  mid: `중간 (σ ≤ ${SIGMA_MID * 100} cm)`,
  low: `낮음 (σ > ${SIGMA_MID * 100} cm)`,
};

/**
 * 정밀도 판정에 쓸 열 후보 — ★앞에 있는 것부터★ 쓸 수 있는지 본다.
 *
 * gps_sigma_m : gps.py _classify() 가 x·y 두 축을 모두 보고 낸 σ. GST 효과가 온전히 반영된다.
 * fix_cov_xx  : /fix 의 position_covariance[0](경도축)뿐이라 반쪽이지만,
 *               GST 가 오면 드라이버가 lon_std_dev 로 대체해 넣으므로 실질적으로 쓸 만하다.
 * gps_quality : NMEA GGA 품질. ★4(RTK 고정)일 때만★ 최상 등급으로 끌어올리는 데 쓴다.
 *               그 밖의 값은 드라이버마다 뜻이 달라 σ 판정을 뒤집지 않는다.
 * fix_status  : NavSatStatus. 드라이버가 RTK 를 STATUS_GBAS_FIX(2) 하나로 뭉뚱그리는 일이 많아
 *               ★σ 가 전혀 없을 때만, 그것도 값이 두 종류 이상일 때만★ 쓴다.
 */
const SIGMA_SOURCES = ["gps_sigma_m", "fix_cov_xx"] as const;
const STATUS_SOURCES = ["gps_quality", "fix_status"] as const;
const RAW_SOURCES = [...SIGMA_SOURCES, ...STATUS_SOURCES] as const;

export interface ParsedTrack {
  kind: TrackKind;
  /** 실제로 읽은 위경도 열 이름 — 화면에 보여 주면 오판을 바로 알아챈다 */
  latColumn: string;
  lonColumn: string;
  pts: LatLng[];
  extras: Extras;
  /** 점마다의 GPS 정밀도 등급. 판정할 근거가 없으면 null */
  quality: Quality[] | null;
  /** 점마다의 표준편차 [m] — 읽음줄과 그래프에 쓴다 */
  sigma: (number | null)[] | null;
  /** 무엇으로 판정했는지 — 근거를 감추지 않는다 */
  qualitySource: string | null;
  /** 판정을 못 했다면 그 이유 */
  qualityNote: string | null;
  /** 파일에 적힌 상태값 원본 요약 — 판정을 사용자가 직접 검증할 수 있게 그대로 보여 준다 */
  statusSummary: string | null;
  totalRows: number;
  /** 값이 비었거나 (0,0) 이라 버린 행 수 */
  skippedRows: number;
  /** 같은 자리에 머무른(hold) 중복 점을 합친 수 */
  mergedRows: number;
  /** 제어 신호 시계열 — ★병합하지 않은 전 행★. 제어 열이 하나도 없으면 null */
  control: ControlSeries | null;
}

/**
 * 따옴표를 지키는 최소 CSV 분해기.
 * 주행 기록 CSV 의 board_status 열은 "A:1,B:1,ESTOP:0,MODE:1" 처럼 ★따옴표 안에 쉼표★
 * 가 들어 있다. split(",") 로 자르면 열이 통째로 밀려 위경도를 엉뚱하게 읽는다.
 */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toNumber(text: string | undefined): number | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 위경도로 못 쓰는 행을 걸러낸다 */
function isUsable(lat: number | null, lon: number | null): lat is number {
  if (lat === null || lon === null) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return false; // 0,0 = 미수신
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

interface QualityVerdict {
  quality: Quality[] | null;
  sigma: (number | null)[] | null;
  qualitySource: string | null;
  qualityNote: string | null;
}

/** 숫자를 보기 좋게 — "2.0" 은 "2" 로 */
function tidy(text: string): string {
  const n = Number(text.trim());
  return Number.isFinite(n) ? String(n) : text.trim();
}

/** 파일에 적힌 상태값을 한 줄로 요약한다 (값이 여러 종류면 모두 나열) */
function summarize(collected: Map<string, string[]>): string | null {
  const parts: string[] = [];
  for (const name of STATUS_SOURCES) {
    const raw = collected.get(name);
    if (!raw?.length) continue;
    const distinct = [...new Set(raw.map(tidy).filter(Boolean))];
    parts.push(`${name}=${distinct.slice(0, 4).join("/")}${distinct.length > 4 ? "…" : ""}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 표본 간 간격의 중앙값 [s]. 20 Hz 기록이면 0.05 가 나온다.
 * 평균이 아니라 중앙값인 이유는 ★기록이 끊겼던 구간 하나가 평균을 통째로 끌기★ 때문이다.
 */
function medianStep(t: number[]): number | null {
  if (t.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

function levelOf(sigma: number): Quality {
  if (sigma <= SIGMA_HIGH) return "high";
  if (sigma <= SIGMA_MID) return "mid";
  return "low";
}

function decideQuality(collected: Map<string, string[]>, count: number): QualityVerdict {
  // ① σ 를 낼 수 있는 열을 먼저 찾는다 — 연속값이라 등급을 나눌 수 있다
  for (const name of SIGMA_SOURCES) {
    const raw = collected.get(name);
    if (!raw?.length) continue;
    const sigma = raw.map((value) => {
      const n = Number(value.trim());
      if (!Number.isFinite(n) || n < 0) return null;
      // fix_cov_xx 는 분산이므로 제곱근을 취해야 표준편차가 된다
      return name === "fix_cov_xx" ? Math.sqrt(n) : n;
    });
    if (!sigma.some((v) => v !== null)) continue;

    // gps_quality 가 4(RTK 고정) 라고 말하면 그것만은 최상 등급으로 끌어올린다
    const ggaRaw = collected.get("gps_quality");
    const quality = sigma.map((v, i) => {
      if (ggaRaw && Number(ggaRaw[i]) === 4) return "high" as Quality;
      return v === null ? "low" : levelOf(v);
    });
    const upgraded = ggaRaw?.some((v) => Number(v) === 4);
    return {
      quality,
      sigma,
      qualitySource: `${name}${upgraded ? " + gps_quality=4" : ""}`,
      qualityNote: null,
    };
  }

  // ② σ 가 없으면 상태 코드로 내려간다 — 값이 한 종류뿐이면 구간이 갈리지 않는다
  for (const name of STATUS_SOURCES) {
    const raw = collected.get(name);
    if (!raw?.length) continue;
    const distinct = new Set(raw.map(tidy).filter(Boolean));
    if (distinct.size < 2) {
      return {
        quality: null,
        sigma: null,
        qualitySource: null,
        qualityNote:
          `정밀도(σ) 열이 없고 ${name} 는 전 구간 ${[...distinct][0] ?? "빈값"} 으로 고정이라 ` +
          `구간을 나눌 수 없습니다. gps_sigma_m 이나 fix_cov_xx 를 함께 기록하면 등급이 나옵니다.`,
      };
    }
    // NMEA GGA 4=RTK 고정 / 5=Float, NavSatStatus 2=STATUS_GBAS_FIX
    return {
      quality: raw.map((value) => {
        const n = Number(value.trim());
        if (n === 4 || n === 2) return "high";
        return n === 5 ? "mid" : "low";
      }),
      sigma: null,
      qualitySource: `${name} (4/2=고정, 5=Float)`,
      qualityNote: null,
    };
  }

  return {
    quality: null,
    sigma: null,
    qualitySource: null,
    qualityNote: count
      ? "GPS 정밀도·상태 열이 없어 품질을 표시하지 않습니다."
      : null,
  };
}

export function parseTrackCsv(text: string): ParsedTrack {
  const rows = splitCsv(text.replace(/^﻿/, "")); // 엑셀이 붙이는 BOM 제거
  if (!rows.length) throw new Error("빈 파일입니다.");

  const header = rows[0].map((name) => name.trim());
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    const key = name.toLowerCase();
    if (!index.has(key)) index.set(key, i);
  });

  // ── 유형 판별 ──────────────────────────────────────────────────────────
  let kind: TrackKind;
  let latIdx: number | undefined;
  let lonIdx: number | undefined;

  if (index.has(MAPPING_LAT) && index.has(MAPPING_LON)) {
    kind = "mapping";
    latIdx = index.get(MAPPING_LAT);
    lonIdx = index.get(MAPPING_LON);
  } else if (index.has(RECORD_LAT) && index.has(RECORD_LON)) {
    kind = "record";
    latIdx = index.get(RECORD_LAT);
    lonIdx = index.get(RECORD_LON);
  } else {
    kind = "unknown";
    latIdx = FALLBACK_LAT.map((k) => index.get(k)).find((i) => i !== undefined);
    lonIdx = FALLBACK_LON.map((k) => index.get(k)).find((i) => i !== undefined);
  }
  if (latIdx === undefined || lonIdx === undefined) {
    throw new Error(
      `위경도 열을 찾지 못했습니다. latitude/longitude(매핑) 또는 fix_lat/fix_lon(주행)이 필요합니다.\n` +
        `이 파일의 열: ${header.slice(0, 10).join(", ")}${header.length > 10 ? " …" : ""}`
    );
  }

  const extraIdx = Object.entries(EXTRA_COLUMNS)
    .map(([name, keys]) => {
      const found = keys.map((k) => index.get(k)).find((i) => i !== undefined);
      return found === undefined ? null : ([name as ExtraName, found] as const);
    })
    .filter((entry): entry is readonly [ExtraName, number] => entry !== null);

  const controlIdx = Object.entries(CONTROL_COLUMNS)
    .map(([name, keys]) => {
      const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
      return hit === undefined ? null : ([name as ControlName, hit] as const);
    })
    .filter((entry): entry is readonly [ControlName, number] => entry !== null);

  const statusIdx = RAW_SOURCES.map((name) => ({ name, idx: index.get(name) })).filter(
    (entry): entry is { name: (typeof RAW_SOURCES)[number]; idx: number } => entry.idx !== undefined
  );

  // ── 본문 ──────────────────────────────────────────────────────────────
  const pts: LatLng[] = [];
  const extras: Extras = {};
  extraIdx.forEach(([name]) => (extras[name] = []));
  const statusRaw = new Map<string, string[]>(statusIdx.map((entry) => [entry.name, []]));
  let skipped = 0;
  let merged = 0;

  // ★제어 시계열은 여기서 갈라진다★ 아래 좌표 루프는 못 쓰는 행을 버리고 hold 중복을
  //   합치지만, 제어 신호는 ★그 행들에도 값이 들어 있다★ — GPS 가 안 잡힌 동안에도
  //   조향은 나가고 있었다. 그래서 전 행을 그대로 담는다.
  const ctrlT: number[] = [];
  const ctrlCols: Partial<Record<ControlName, (number | null)[]>> = {};
  controlIdx.forEach(([name]) => (ctrlCols[name] = []));
  const tIdx = EXTRA_COLUMNS.t.map((k) => index.get(k)).find((i) => i !== undefined);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && !row[0].trim()) continue; // 끝의 빈 줄

    if (controlIdx.length) {
      // 시간 열이 없으면 행 번호를 20 Hz 로 환산해 쓴다 — 가로축이 없으면 그릴 수 없다
      ctrlT.push(tIdx === undefined ? ctrlT.length * 0.05 : toNumber(row[tIdx]) ?? ctrlT.length * 0.05);
      for (const [name, idx] of controlIdx) ctrlCols[name]!.push(toNumber(row[idx]));
    }

    const lat = toNumber(row[latIdx]);
    const lon = toNumber(row[lonIdx]);
    if (!isUsable(lat, lon)) {
      skipped++;
      continue;
    }
    // 주행 기록 표는 20Hz 스냅샷이라 5Hz GPS 값이 그대로 유지(hold)되어 같은 점이
    // 여러 줄 반복된다. 그림엔 영향이 없지만 오차 통계에서 같은 점이 여러 번 세어져
    // 평균이 왜곡되므로 ★연속 중복은 하나로★ 합친다.
    const last = pts[pts.length - 1];
    if (last && last.lat === lat && last.lng === lon) {
      merged++;
      continue;
    }
    pts.push({ lat, lng: lon as number });
    for (const [name, idx] of extraIdx) extras[name]!.push(toNumber(row[idx]));
    for (const entry of statusIdx) statusRaw.get(entry.name)!.push(row[entry.idx] ?? "");
  }

  if (!pts.length) throw new Error("쓸 수 있는 위경도 행이 하나도 없습니다.");

  const verdict = decideQuality(statusRaw, pts.length);

  return {
    kind,
    latColumn: header[latIdx],
    lonColumn: header[lonIdx],
    pts,
    extras,
    quality: verdict.quality,
    sigma: verdict.sigma,
    qualitySource: verdict.qualitySource,
    qualityNote: verdict.qualityNote,
    statusSummary: summarize(statusRaw),
    totalRows: rows.length - 1,
    skippedRows: skipped,
    mergedRows: merged,
    control: controlIdx.length
      ? {
          t: ctrlT,
          cols: ctrlCols,
          found: controlIdx.map(([, idx]) => header[idx]),
          periodS: medianStep(ctrlT),
        }
      : null,
  };
}

export async function readTrackFile(file: File): Promise<ParsedTrack> {
  return parseTrackCsv(await file.text());
}

export const KIND_LABEL: Record<TrackKind, string> = {
  mapping: "매핑",
  record: "주행",
  unknown: "미상",
};
