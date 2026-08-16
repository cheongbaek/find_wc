import { useMemo, type PointerEvent } from "react";

interface Props {
  /** 각 점의 오차 [m] */
  err: number[];
  /** 각 점까지의 누적 주행거리 [m] — 가로축 */
  dist: number[];
  errMax: number;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}

const W = 300;
const H = 76;
const PAD_BOTTOM = 12; // 아래쪽 눈금 글씨 자리

/**
 * 주행 거리에 따른 오차 프로파일.
 * 점이 수천 개여도 가로 300px 이라 다 그릴 수 없다 — 픽셀당 한 칸으로 묶되
 * ★그 구간의 최댓값★ 을 남긴다(평균을 쓰면 순간적으로 크게 벗어난 곳이 사라진다).
 */
export default function ErrorProfile({ err, dist, errMax, hoverIdx, onHover }: Props) {
  const cols = useMemo(() => {
    const total = dist[dist.length - 1] || 1;
    const out: { x: number; err: number; idx: number }[] = new Array(W);
    let cursor = 0;
    for (let c = 0; c < W; c++) {
      const until = ((c + 1) / W) * total;
      let best = -1;
      let bestIdx = cursor;
      while (cursor < err.length && (dist[cursor] <= until || cursor === 0)) {
        if (err[cursor] > best) {
          best = err[cursor];
          bestIdx = cursor;
        }
        cursor++;
      }
      const prev = out[c - 1];
      out[c] =
        best >= 0
          ? { x: c, err: best, idx: bestIdx }
          : { x: c, err: prev ? prev.err : 0, idx: prev ? prev.idx : 0 };
    }
    return out;
  }, [err, dist]);

  const plotH = H - PAD_BOTTOM;
  const yOf = (v: number) => plotH - Math.min(v / errMax, 1.15) * plotH;

  const area = useMemo(() => {
    const top = cols.map((c) => `${c.x},${yOf(c.err).toFixed(1)}`).join(" L");
    return `M0,${plotH} L${top} L${W - 1},${plotH} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, errMax]);

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
      onPointerMove={pick}
      onPointerLeave={() => onHover(null)}
    >
      <line className="grid" x1="0" y1={yOf(errMax)} x2={W} y2={yOf(errMax)} />
      <line className="grid" x1="0" y1={yOf(errMax / 2)} x2={W} y2={yOf(errMax / 2)} />
      <path className="area" d={area} />
      {hoverX !== null && <line className="cur" x1={hoverX} y1="0" x2={hoverX} y2={plotH} />}
      <text x="2" y={yOf(errMax) - 2}>
        {errMax} m
      </text>
      <text x="2" y={H - 2}>
        0 m
      </text>
      <text x={W - 2} y={H - 2} textAnchor="end">
        {(dist[dist.length - 1] ?? 0).toFixed(0)} m
      </text>
    </svg>
  );
}
