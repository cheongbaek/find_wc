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
 * ★이 표준편차 이하면 RTK 고정으로 본다 [m]★
 * RTK Fixed 는 보통 1~3 cm, Float 이나 단독측위로 떨어지면 수십 cm~수 m 다.
 * 실측 데이터는 σ 가 1.0~1.4 cm 아니면 2.1~2.6 m 로 뚜렷하게 둘로 갈렸다 —
 * 그 사이(5~50 cm)에 걸친 점이 하나도 없었으므로 경계값 선택이 결과를 바꾸지 않는다.
 */
export const RTK_SIGMA_M = 0.1;

/**
 * RTK 판정에 쓸 열 후보 — ★앞에 있는 것부터★ 쓸 수 있는지 본다.
 *
 * gps_quality  : /gps_fused 쪽 판정 결과. 있으면 이게 가장 정확하다.
 * gps_sigma_m  : gps.py _classify() 가 x·y 두 축을 모두 보고 낸 σ. GST 효과가 온전히 반영된다.
 * fix_cov_xx   : /fix 의 position_covariance[0](경도축)뿐이라 반쪽이지만,
 *                GST 가 오면 드라이버가 lon_std_dev 로 대체해 넣으므로 실질적으로 쓸 만하다.
 * fix_status   : NavSatStatus. 드라이버가 RTK 를 STATUS_GBAS_FIX(2) 하나로 뭉뚱그리는 일이 많아
 *                ★값이 한 종류뿐이면 판정에 쓰지 않는다★ (실측 파일이 정확히 그랬다).
 */
const RTK_SOURCES = ["gps_quality", "gps_sigma_m", "fix_cov_xx", "fix_status"] as const;

export interface ParsedTrack {
  kind: TrackKind;
  /** 실제로 읽은 위경도 열 이름 — 화면에 보여 주면 오판을 바로 알아챈다 */
  latColumn: string;
  lonColumn: string;
  pts: LatLng[];
  extras: Extras;
  /** 점마다 RTK 고정이었는지. 판정할 근거가 없으면 null */
  rtk: boolean[] | null;
  /** 무엇으로 판정했는지 — 근거를 감추지 않는다 */
  rtkSource: string | null;
  /** 판정을 못 했다면 그 이유 */
  rtkNote: string | null;
  totalRows: number;
  /** 값이 비었거나 (0,0) 이라 버린 행 수 */
  skippedRows: number;
  /** 같은 자리에 머무른(hold) 중복 점을 합친 수 */
  mergedRows: number;
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

interface RtkVerdict {
  rtk: boolean[] | null;
  rtkSource: string | null;
  rtkNote: string | null;
}

/** 한 후보 열의 원본 문자열들로 RTK 여부를 판정한다. 못 쓰면 null 을 돌려준다. */
function classify(column: string, raw: string[]): RtkVerdict | null {
  const key = column.toLowerCase();

  if (key === "gps_quality") {
    // 숫자면 NMEA GGA 품질(4=RTK 고정, 5=Float), 글자면 드라이버가 붙인 이름
    const flags = raw.map((value) => {
      const text = value.trim().toUpperCase();
      if (!text) return false;
      const n = Number(text);
      if (Number.isFinite(n)) return n === 4;
      return text.includes("FIX") && !text.includes("FLOAT");
    });
    return { rtk: flags, rtkSource: `${column} (4=RTK 고정)`, rtkNote: null };
  }

  if (key === "gps_sigma_m" || key === "fix_cov_xx") {
    // fix_cov_xx 는 분산이므로 제곱근을 취해야 표준편차가 된다
    const sigma = raw.map((value) => {
      const n = toNumber(value);
      if (n === null || n < 0) return NaN;
      return key === "fix_cov_xx" ? Math.sqrt(n) : n;
    });
    if (!sigma.some(Number.isFinite)) return null;
    return {
      rtk: sigma.map((s) => Number.isFinite(s) && s <= RTK_SIGMA_M),
      rtkSource: `${column} (σ ≤ ${RTK_SIGMA_M} m)`,
      rtkNote: null,
    };
  }

  // fix_status: 값이 한 종류뿐이면 구간이 갈리지 않는다 — 판정에 쓰지 않는다
  const distinct = new Set(raw.map((v) => v.trim()).filter(Boolean));
  if (distinct.size < 2) {
    return {
      rtk: null,
      rtkSource: null,
      rtkNote:
        `${column} 가 전 구간 ${[...distinct][0] ?? "빈값"} 으로 고정이라 RTK 구분에 쓸 수 없습니다. ` +
        `드라이버가 RTK 를 NavSatStatus 한 값으로 뭉뚱그린 경우입니다.`,
    };
  }
  // 갈리는 경우: NMEA GGA 4=RTK 고정, NavSatStatus 2=STATUS_GBAS_FIX
  return {
    rtk: raw.map((value) => {
      const n = toNumber(value);
      return n === 4 || n === 2;
    }),
    rtkSource: `${column} (2/4 를 RTK 로 봄)`,
    rtkNote: null,
  };
}

function decideRtk(collected: Map<string, string[]>): RtkVerdict {
  let note: string | null = null;
  for (const name of RTK_SOURCES) {
    const raw = collected.get(name);
    if (!raw || !raw.length) continue;
    const verdict = classify(name, raw);
    if (verdict?.rtk) return verdict;
    if (verdict?.rtkNote && !note) note = verdict.rtkNote; // 첫 번째 실패 사유만 알린다
  }
  return { rtk: null, rtkSource: null, rtkNote: note };
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

  const rtkIdx = RTK_SOURCES.map((name) => ({ name, idx: index.get(name) })).filter(
    (entry): entry is { name: (typeof RTK_SOURCES)[number]; idx: number } => entry.idx !== undefined
  );

  // ── 본문 ──────────────────────────────────────────────────────────────
  const pts: LatLng[] = [];
  const extras: Extras = {};
  extraIdx.forEach(([name]) => (extras[name] = []));
  const rtkRaw = new Map<string, string[]>(rtkIdx.map((entry) => [entry.name, []]));
  let skipped = 0;
  let merged = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && !row[0].trim()) continue; // 끝의 빈 줄
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
    for (const entry of rtkIdx) rtkRaw.get(entry.name)!.push(row[entry.idx] ?? "");
  }

  if (!pts.length) throw new Error("쓸 수 있는 위경도 행이 하나도 없습니다.");

  const verdict = decideRtk(rtkRaw);

  return {
    kind,
    latColumn: header[latIdx],
    lonColumn: header[lonIdx],
    pts,
    extras,
    rtk: verdict.rtk,
    rtkSource: verdict.rtkSource,
    rtkNote: verdict.rtkNote,
    totalRows: rows.length - 1,
    skippedRows: skipped,
    mergedRows: merged,
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
