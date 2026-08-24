import { useEffect, useRef } from "react";
import type { Quality } from "../lib/csv";
import { errColor, type LatLng } from "../lib/geo";

export type MapType = "sat" | "hybrid" | "road";
export type ColorMode = "solid" | "err";

export interface MapTrack {
  id: string;
  color: string;
  pts: LatLng[];
  /** 주행 궤적일 때만 채워진다 — 각 점의 매핑 궤적까지의 거리 [m] */
  err: number[] | null;
  /** 점마다의 GPS 정밀도 등급. 없으면 밝기 구분을 하지 않는다 */
  quality: Quality[] | null;
}

interface Props {
  tracks: MapTrack[];
  mapType: MapType;
  colorMode: ColorMode;
  errMax: number;
  /** 오차 그래프에서 가리키는 지점 — 지도에 흰 점으로 표시한다 */
  cursor: LatLng | null;
  /** 값이 바뀌면 전체 궤적이 보이도록 화면을 다시 맞춘다 */
  fitToken: number;
  /** 패널에 가리지 않도록 왼쪽에 비워 둘 폭 [px] */
  padLeft: number;
}

/** 오차 색을 몇 단계로 끊을지 — 너무 잘게 나누면 선 조각이 수천 개가 된다 */
const ERR_STEPS = 16;

/**
 * 등급별 밝기 (0=검정, 1=그대로).
 * ★정밀할수록 밝다★ — 지도와 아래 띠가 같은 규칙을 쓴다.
 */
const LEVEL_DIM: Record<Quality, number> = { high: 1, mid: 0.7, low: 0.4 };

interface Removable {
  setMap(map: kakao.maps.Map | null): void;
}

/**
 * 정밀도가 낮은 구간용 어두운 색.
 * 명도만 낮추면 위성 영상 위에서 탁하게 보여, 채도도 함께 낮춰 ★죽은 색★ 으로 만든다.
 * errColor 가 내는 hsl() 과 궤적 기본색인 #rrggbb 를 모두 받는다.
 */
function darken(color: string, dim: number): string {
  if (dim >= 1) return color;
  const hsl = /^hsl\((\d+(?:\.\d+)?) (\d+)% (\d+)%\)$/.exec(color);
  if (hsl) {
    const sat = Math.round(Number(hsl[2]) * (0.4 + 0.6 * dim));
    return `hsl(${hsl[1]} ${sat}% ${Math.round(Number(hsl[3]) * dim)}%)`;
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!hex) return color;
  const n = parseInt(hex[1], 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * dim));
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 점마다 색을 정한다.
 * - 오차 색 모드: 벗어난 거리를 단계로 끊어 초록→빨강
 * - 단색 모드   : 궤적 고유색
 * 그리고 ★GPS 정밀도가 낮은 점일수록 어둡게★ — 밝으면 RTK 고정급이다.
 */
function colorPicker(track: MapTrack, colorMode: ColorMode, errMax: number) {
  const useErr = colorMode === "err" && track.err;
  return (i: number) => {
    let color = track.color;
    if (useErr) {
      // 단계로 끊어야 같은 색이 이어지고, 선 조각 수가 폭발하지 않는다
      const level = Math.min(
        ERR_STEPS - 1,
        Math.floor((Math.min(track.err![i] ?? 0, errMax) / errMax) * ERR_STEPS)
      );
      color = errColor((level / ERR_STEPS) * errMax, errMax);
    }
    const level = track.quality?.[i];
    return level ? darken(color, LEVEL_DIM[level]) : color;
  };
}

/**
 * 색이 같은 점끼리 묶어 구간(run) 으로 자른다.
 * 구간의 끝점을 다음 구간의 시작점으로 겹쳐 넣어야 선이 끊겨 보이지 않는다.
 */
function colorRuns(pts: LatLng[], colorAt: (i: number) => string) {
  const runs: { color: string; pts: LatLng[] }[] = [];
  let start = 0;
  let color = colorAt(0);
  for (let i = 1; i <= pts.length; i++) {
    const next = i < pts.length ? colorAt(i) : null;
    if (next !== color) {
      runs.push({ color, pts: pts.slice(start, Math.min(i + 1, pts.length)) });
      start = i;
      if (next !== null) color = next;
    }
  }
  return runs;
}

export default function MapView({
  tracks,
  mapType,
  colorMode,
  errMax,
  cursor,
  fitToken,
  padLeft,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const drawnRef = useRef<Removable[]>([]);
  const overlayTypeRef = useRef<kakao.maps.MapTypeId | null>(null);
  const cursorRef = useRef<kakao.maps.CustomOverlay | null>(null);

  // ── 지도 생성 (한 번만) ────────────────────────────────────────────────
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    mapRef.current = new window.kakao.maps.Map(boxRef.current, {
      center: new window.kakao.maps.LatLng(36.9675, 127.8729),
      level: 3,
    });
  }, []);

  // ── 지도 유형 (위성 / 위성+도로 / 일반) ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { MapTypeId } = window.kakao.maps;

    if (overlayTypeRef.current) {
      map.removeOverlayMapTypeId(overlayTypeRef.current);
      overlayTypeRef.current = null;
    }
    map.setMapTypeId(mapType === "road" ? MapTypeId.ROADMAP : MapTypeId.SKYVIEW);
    if (mapType === "hybrid") {
      map.addOverlayMapTypeId(MapTypeId.HYBRID); // 위성 위에 도로·지명을 얹는다
      overlayTypeRef.current = MapTypeId.HYBRID;
    }
  }, [mapType]);

  // ── 궤적 그리기 ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { LatLng, Polyline } = window.kakao.maps;

    drawnRef.current.forEach((obj) => obj.setMap(null));
    drawnRef.current = [];

    const keep = (obj: Removable) => drawnRef.current.push(obj);
    const line = (pts: LatLng[], color: string, weight: number, opacity: number, z: number) =>
      keep(
        new Polyline({
          map,
          path: pts.map((p) => new LatLng(p.lat, p.lng)),
          strokeColor: color,
          strokeWeight: weight,
          strokeOpacity: opacity,
          strokeStyle: "solid",
          zIndex: z,
        })
      );

    tracks.forEach((track, order) => {
      if (track.pts.length < 2) return;
      const base = 10 + order * 10;

      // 위성 영상은 배경이 제각각이라 선만 그리면 묻힌다 — 어두운 테두리를 깔아 준다
      line(track.pts, "#000000", 7, 0.45, base);

      colorRuns(track.pts, colorPicker(track, colorMode, errMax)).forEach((run) => {
        if (run.pts.length >= 2) line(run.pts, run.color, 4, 0.95, base + 1);
      });
    });
  }, [tracks, colorMode, errMax]);

  // ── 오차 그래프에서 가리키는 지점 ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!cursorRef.current) {
      cursorRef.current = new window.kakao.maps.CustomOverlay({
        position: new window.kakao.maps.LatLng(0, 0),
        content: '<div class="cursor-dot"></div>',
        yAnchor: 0.5,
        xAnchor: 0.5,
        zIndex: 900,
      });
    }
    const overlay = cursorRef.current;
    if (cursor) {
      overlay.setPosition(new window.kakao.maps.LatLng(cursor.lat, cursor.lng));
      overlay.setMap(map);
    } else {
      overlay.setMap(null);
    }
  }, [cursor]);

  // ── 전체 보기 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tracks.length) return;
    const bounds = new window.kakao.maps.LatLngBounds();
    let count = 0;
    tracks.forEach((track) =>
      track.pts.forEach((p) => {
        bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng));
        count++;
      })
    );
    if (count) map.setBounds(bounds, 48, 48, 48, padLeft);
    // padLeft 는 화면 폭이 바뀔 때만 달라진다 — 그때마다 다시 맞출 필요는 없다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);

  return <div className="map" ref={boxRef} />;
}
