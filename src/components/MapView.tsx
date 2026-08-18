import { useEffect, useRef } from "react";
import { errColor, type LatLng } from "../lib/geo";

export type MapType = "sat" | "hybrid" | "road";
export type ColorMode = "solid" | "err";

export interface MapTrack {
  id: string;
  color: string;
  pts: LatLng[];
  /** 주행 궤적일 때만 채워진다 — 각 점의 매핑 궤적까지의 거리 [m] */
  err: number[] | null;
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

interface Removable {
  setMap(map: kakao.maps.Map | null): void;
}

/**
 * 오차 색 모드에서는 한 궤적을 ★색이 같은 구간(run)★ 단위로 잘라 그린다.
 * 구간의 끝점을 다음 구간의 시작점으로 겹쳐 넣어야 선이 끊겨 보이지 않는다.
 */
function colorRuns(pts: LatLng[], err: number[], errMax: number) {
  const runs: { color: string; pts: LatLng[] }[] = [];
  const level = (i: number) =>
    Math.min(ERR_STEPS - 1, Math.floor((Math.min(err[i] ?? 0, errMax) / errMax) * ERR_STEPS));

  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || level(i) !== level(start)) {
      runs.push({
        color: errColor(err[start] ?? 0, errMax),
        pts: pts.slice(start, Math.min(i + 1, pts.length)), // 한 점 겹쳐 이어 붙인다
      });
      start = i;
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

      if (colorMode === "err" && track.err) {
        colorRuns(track.pts, track.err, errMax).forEach((run) => {
          if (run.pts.length >= 2) line(run.pts, run.color, 4, 0.95, base + 1);
        });
      } else {
        line(track.pts, track.color, 4, 0.95, base + 1);
      }
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
