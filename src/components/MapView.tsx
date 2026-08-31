import { useEffect, useRef } from "react";
import type { Quality } from "../lib/csv";
import { errColor, type LatLng } from "../lib/geo";

export type MapType = "sat" | "road";
export type ColorMode = "solid" | "err";

/** 그리기 모드에서 지도가 보여 줄 것과, 지도가 돌려줄 사건 */
export interface DrawState {
  /**
   * ★지금 클릭을 받는가★ — '그려 둔 것을 보여 주는 것'과 갈라 놓는다.
   *
   * 매핑을 종료해도 그린 궤적은 지도에 남아야 하므로 이 객체 자체는 계속 넘어온다.
   * 그래서 객체의 유무로 입력 허용을 판단하면 ★종료한 뒤에도 클릭이 먹는다★ —
   * 실제로 그렇게 냈다가 잡았다. 입력 허용은 반드시 이 깃발로만 본다.
   */
  active: boolean;
  /** 지금까지 확정된 점(보간 포함) */
  pts: LatLng[];
  /** 사용자가 실제로 클릭한 자리 — 굵은 표식으로 구별한다 */
  vertices: LatLng[];
  /** 마우스가 지금 있는 자리 (격자에 물리기 전) */
  cursor: LatLng | null;
  /** 지금 클릭하면 찍힐 자리 (격자에 물린 뒤) */
  preview: LatLng | null;
}

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
  /** 그리기 중이면 그 상태. null 이면 종전대로 보기 전용 */
  draw: DrawState | null;
  /** 지도를 클릭했다 (끌기는 걸러진 뒤) */
  onDrawClick: (at: LatLng) => void;
  /** 마우스가 움직였다 — 예정 지점을 다시 계산하라는 뜻 */
  onDrawMove: (at: LatLng | null) => void;
  /** 오른쪽 클릭 = 지정 완료 */
  onDrawFinish: () => void;
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
  draw,
  onDrawClick,
  onDrawMove,
  onDrawFinish,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const drawnRef = useRef<Removable[]>([]);
  const overlayTypeRef = useRef<kakao.maps.MapTypeId | null>(null);
  const cursorRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const sketchRef = useRef<Removable[]>([]);

  // ★콜백을 ref 로 붙든다★ 카카오 이벤트는 한 번만 걸고 싶은데, 콜백은 매 렌더
  //   새로 만들어진다. 의존성에 넣으면 렌더마다 이벤트를 떼었다 다시 단다.
  const handlers = useRef({ onDrawClick, onDrawMove, onDrawFinish, active: false });
  handlers.current.onDrawClick = onDrawClick;
  handlers.current.onDrawMove = onDrawMove;
  handlers.current.onDrawFinish = onDrawFinish;
  handlers.current.active = draw?.active === true;

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

  // ── 그리기 : 지도 사건 받기 (한 번만 건다) ────────────────────────────
  //  ★클릭과 끌기를 갈라야 한다★ 카카오의 '거리 재기'처럼, 눌렀다 뗀 자리가 거의
  //  같을 때만 점을 찍고 그 이상 움직였으면 지도를 옮긴 것으로 본다. 그래야 그리는
  //  도중에도 지도를 자유롭게 끌 수 있다.
  useEffect(() => {
    const map = mapRef.current;
    const box = boxRef.current;
    if (!map || !box) return;
    const { event } = window.kakao.maps;

    let downX = 0;
    let downY = 0;
    let moved = false;
    const DRAG_PX = 5; // 이보다 움직였으면 끌기다 (손떨림 여유)

    const down = (e: MouseEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
    };
    const move = (e: MouseEvent) => {
      if (e.buttons && Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) moved = true;
    };
    // 그리는 동안에는 오른쪽 클릭이 '완료'이므로 브라우저 메뉴를 막는다
    const menu = (e: MouseEvent) => {
      if (handlers.current.active) e.preventDefault();
    };
    box.addEventListener("mousedown", down);
    box.addEventListener("mousemove", move);
    box.addEventListener("contextmenu", menu);

    const onClick = (e: kakao.maps.MouseEvent) => {
      if (!handlers.current.active || moved) return;
      handlers.current.onDrawClick({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
    };
    const onMove = (e: kakao.maps.MouseEvent) => {
      if (!handlers.current.active) return;
      handlers.current.onDrawMove({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
    };
    const onRight = () => {
      if (handlers.current.active) handlers.current.onDrawFinish();
    };

    event.addListener(map, "click", onClick);
    event.addListener(map, "mousemove", onMove);
    event.addListener(map, "rightclick", onRight);
    return () => {
      box.removeEventListener("mousedown", down);
      box.removeEventListener("mousemove", move);
      box.removeEventListener("contextmenu", menu);
      event.removeListener(map, "click", onClick);
      event.removeListener(map, "mousemove", onMove);
      event.removeListener(map, "rightclick", onRight);
    };
  }, []);

  // ── 그리기 : 그리는 중인 궤적 ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { LatLng, Polyline, CustomOverlay } = window.kakao.maps;

    sketchRef.current.forEach((obj) => obj.setMap(null));
    sketchRef.current = [];
    if (!draw) return;

    const keep = (obj: Removable) => sketchRef.current.push(obj);
    const dot = (p: LatLng, cls: string, z: number) =>
      keep(
        new CustomOverlay({
          map,
          position: new LatLng(p.lat, p.lng),
          content: `<div class="${cls}"></div>`,
          xAnchor: 0.5,
          yAnchor: 0.5,
          zIndex: z,
        })
      );

    if (draw.pts.length >= 2) {
      const path = draw.pts.map((p) => new LatLng(p.lat, p.lng));
      keep(new Polyline({ map, path, strokeColor: "#000000", strokeWeight: 7, strokeOpacity: 0.45, zIndex: 800 }));
      keep(new Polyline({ map, path, strokeColor: "#ffd60a", strokeWeight: 4, strokeOpacity: 0.95, zIndex: 801 }));
    }

    // 격자에 물린 점들 — 간격이 눈에 보여야 스냅이 도는지 확인할 수 있다.
    // 수백 개를 넘으면 오버레이 값이 비싸지므로 그때는 선만 남긴다.
    if (draw.pts.length <= 600) draw.pts.forEach((p) => dot(p, "grid-dot", 810));
    draw.vertices.forEach((p) => dot(p, "vertex-dot", 820));

    // ★커서와 예정 지점을 나란히 보여 준다★ 둘 사이가 벌어져 보이는 만큼이
    //   격자에 당겨진 거리다. 점선으로 이어야 '이게 저기로 간다'가 읽힌다.
    if (draw.preview) {
      const last = draw.pts[draw.pts.length - 1];
      if (last) {
        keep(
          new Polyline({
            map,
            path: [new LatLng(last.lat, last.lng), new LatLng(draw.preview.lat, draw.preview.lng)],
            strokeColor: "#ffd60a",
            strokeWeight: 3,
            strokeOpacity: 0.85,
            strokeStyle: "shortdash",
            zIndex: 802,
          })
        );
      }
      dot(draw.preview, "preview-dot", 830);
    }
    if (draw.cursor) dot(draw.cursor, "raw-dot", 829);
  }, [draw]);

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

  return <div className={`map${draw?.active ? " drawing" : ""}`} ref={boxRef} />;
}
