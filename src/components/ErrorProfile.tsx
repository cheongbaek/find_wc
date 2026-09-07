import { useMemo, type PointerEvent } from "react";
import type { Quality } from "../lib/csv";

interface Props {
  /**
   * 세로축 값 — 매핑 기준이 있으면 벗어난 거리, 없으면 GPS 표준편차 σ.
   *
   * ★그릴 값이 하나도 없으면 null★ 이다(매핑 기준도 없고 GPS 정밀도 열도 없는 CSV).
   * 그때는 곡선을 그리지 않고 ★위치를 고르는 막대★ 만 낸다 — 없는 값을 0 으로 채워
   * 그리면 "σ 가 0" 으로 읽히기 때문이다(CLAUDE.md: 없는 것을 0으로 채우지 말 것).
   * 값이 없어도 가로축(주행거리)은 있으므로, 긁어서 그 지점의 위경도는 볼 수 있다.
   */
  values: number[] | null;
  /** 각 점까지의 누적 주행거리 [m] — 가로축 */
  dist: number[];
  valueMax: number;
  /** 위쪽 눈금에 적을 글자 (예: "1 m"). values 가 null 이면 쓰지 않는다 */
  topLabel: string;
  /** 각 점의 GPS 정밀도 등급. 없으면 아래 띠를 그리지 않는다 */
  quality: Quality[] | null;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}

const W = 300;
const H = 88;
const PAD_BOTTOM = 14; // 아래쪽 눈금 글씨 자리
const BAND_H = 6; // 정밀도 띠 높이
const BAND_GAP = 3;
const PLOT_H = H - PAD_BOTTOM - BAND_H - BAND_GAP;
const BAND_Y = PLOT_H + BAND_GAP;

/** 띠 색 — ★같은 색상에서 밝기만 다르게★ 해서 지도의 규칙과 똑같이 읽히게 한다 */
const BAND_COLOR: Record<Quality, string> = {
  high: "hsl(150 58% 55%)",
  mid: "hsl(150 32% 42%)",
  low: "hsl(150 14% 30%)",
};
/** 띠 바탕 — 등급이 낮아도 "빈 칸"이 아니라 채워진 막대로 보이게 한다 */
const BAND_BASE = "hsl(150 8% 18%)";
/** 값이 없을 때 곡선 자리에 그리는 홈(막대)의 두께 */
const LANE_H = 6;

/**
 * 주행 거리에 따른 프로파일 + 그 아래 GPS 정밀도 띠.
 * 점이 수천 개여도 가로 300px 이라 다 그릴 수 없다 — 픽셀당 한 칸으로 묶되
 * ★그 구간의 최댓값★ 을 남긴다(평균을 쓰면 순간적으로 크게 벗어난 곳이 사라진다).
 */
export default function ErrorProfile({
  values,
  dist,
  valueMax,
  topLabel,
  quality,
  hoverIdx,
  onHover,
}: Props) {
  const cols = useMemo(() => {
    const total = dist[dist.length - 1] || 1;
    const out: { x: number; value: number; idx: number }[] = new Array(W);
    let cursor = 0;
    // ★값이 없을 때는 거리만으로 칸을 나눈다★ 고를 지점(idx)만 있으면 되므로
    //   '그 구간의 최댓값' 을 찾을 것이 없다. 빈 칸도 남기지 않는다 — 점이 300개보다
    //   적어도 칸마다 가장 가까운 앞 점을 물려, 막대 어디를 눌러도 지점이 잡힌다.
    if (!values) {
      const n = dist.length;
      for (let c = 0; c < W; c++) {
        const until = ((c + 1) / W) * total;
        while (cursor + 1 < n && dist[cursor + 1] <= until) cursor++;
        out[c] = { x: c, value: 0, idx: cursor };
      }
      return out;
    }
    for (let c = 0; c < W; c++) {
      const until = ((c + 1) / W) * total;
      let best = -1;
      let bestIdx = cursor;
      while (cursor < values.length && (dist[cursor] <= until || cursor === 0)) {
        if (values[cursor] > best) {
          best = values[cursor];
          bestIdx = cursor;
        }
        cursor++;
      }
      const prev = out[c - 1];
      out[c] =
        best >= 0
          ? { x: c, value: best, idx: bestIdx }
          : { x: c, value: prev ? prev.value : 0, idx: prev ? prev.idx : 0 };
    }
    return out;
  }, [values, dist]);

  const yOf = (v: number) => PLOT_H - Math.min(v / valueMax, 1.15) * PLOT_H;

  const area = useMemo(() => {
    if (!values) return null;
    const top = cols.map((c) => `${c.x},${yOf(c.value).toFixed(1)}`).join(" L");
    return `M0,${PLOT_H} L${top} L${W - 1},${PLOT_H} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, valueMax, values]);

  // 정밀도 띠 — 등급이 같은 칸끼리 묶어 사각형 하나로 그린다
  const bands = useMemo(() => {
    if (!quality) return [];
    const out: { x: number; w: number; level: Quality }[] = [];
    let start = 0;
    let level = quality[cols[0].idx] ?? "low";
    for (let c = 1; c <= cols.length; c++) {
      const next = c < cols.length ? quality[cols[c].idx] ?? "low" : null;
      if (next !== level) {
        out.push({ x: start, w: c - start, level });
        start = c;
        if (next !== null) level = next;
      }
    }
    return out;
  }, [cols, quality]);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const c = Math.round(((e.clientX - rect.left) / rect.width) * (W - 1));
    const col = cols[Math.max(0, Math.min(W - 1, c))];
    onHover(col ? col.idx : null);
  };

  const hoverX = useMemo(() => {
    if (hoverIdx == null) return null;
    const col = cols.find((c) => c.idx >= hoverIdx);
    return col ? col.x : null;
  }, [cols, hoverIdx]);

  return (
    <svg
      className="profile"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId); // 손가락으로 끌어도 따라오게
        pick(e);
      }}
      onPointerMove={pick}
      // ★onPointerLeave 로 선택을 지우지 않는다★ 손을 떼거나 그래프 밖으로
      //   나가도 고른 지점이 남아야 아래 표의 값을 천천히 읽을 수 있다.
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
    >
      {area !== null ? (
        <>
          <line className="grid" x1="0" y1={yOf(valueMax)} x2={W} y2={yOf(valueMax)} />
          <line className="grid" x1="0" y1={yOf(valueMax / 2)} x2={W} y2={yOf(valueMax / 2)} />
          <path className="area" d={area} />
        </>
      ) : (
        // ★값이 없을 때의 막대★ 세로축이 없다는 것을 눈으로도 알 수 있게 곡선 자리를
        //   비우고 가운데에 홈만 그린다. 잡는 자리는 그대로 SVG 전체다.
        <rect className="lane" x="0" y={PLOT_H / 2 - LANE_H / 2} width={W} height={LANE_H} />
      )}

      {quality && <rect x="0" y={BAND_Y} width={W} height={BAND_H} fill={BAND_BASE} />}
      {bands.map((b) => (
        <rect key={b.x} x={b.x} y={BAND_Y} width={b.w} height={BAND_H} fill={BAND_COLOR[b.level]} />
      ))}

      {hoverX !== null && (
        <line className="cur" x1={hoverX} y1="0" x2={hoverX} y2={BAND_Y + BAND_H} />
      )}

      {area !== null && (
        <text x="2" y={yOf(valueMax) - 2}>
          {topLabel}
        </text>
      )}
      <text x="2" y={H - 3}>
        0
      </text>
      <text x={W - 2} y={H - 3} textAnchor="end">
        {(dist[dist.length - 1] ?? 0).toFixed(0)} m
      </text>
    </svg>
  );
}
