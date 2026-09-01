import { useMemo, type PointerEvent } from "react";

export interface Signal {
  label: string;
  color: string;
  values: (number | null)[];
  /** 점선으로 그린다 — '지령'과 '실측'처럼 짝을 이루는 신호를 구별할 때 */
  dashed?: boolean;
}

export interface Guide {
  /** 가로 기준선을 그을 값 */
  at: number;
  label?: string;
}

interface Props {
  title: string;
  unit: string;
  /** 가로축 [s] — 모든 신호가 이 배열과 같은 길이여야 한다 */
  t: number[];
  signals: Signal[];
  /** 눈금을 0 중심 대칭으로 잡는다 (조향처럼 부호가 뜻을 갖는 신호) */
  symmetric?: boolean;
  /** 세로축 하한을 0 으로 고정한다 (속도처럼 음수가 없는 신호) */
  zeroBased?: boolean;
  guides?: Guide[];
  /** 가리키는 표본의 번호 (제어 시계열 기준). 차트끼리 공유한다 */
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}

const W = 300;
const H = 66;
const PAD_BOTTOM = 11;
const PLOT_H = H - PAD_BOTTOM;

/** 한 픽셀 칸에 담긴 값의 범위. 평균으로 뭉개면 조향 채터링이 사라진다 */
interface Col {
  min: number;
  max: number;
  last: number;
  idx: number;
  ok: boolean;
}

function binned(values: (number | null)[], n: number): Col[] {
  const out: Col[] = new Array(W);
  for (let c = 0; c < W; c++) {
    const from = Math.floor((c / W) * n);
    const to = Math.max(from + 1, Math.floor(((c + 1) / W) * n));
    let min = Infinity;
    let max = -Infinity;
    let last = 0;
    let idx = from;
    for (let i = from; i < to && i < n; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) {
        max = v;
        idx = i;
      }
      last = v;
    }
    const ok = min <= max;
    const prev = out[c - 1];
    out[c] = ok
      ? { min, max, last, idx, ok: true }
      : prev
        ? { ...prev, ok: false }
        : { min: 0, max: 0, last: 0, idx: from, ok: false };
  }
  return out;
}

/** 눈금 숫자를 짧게 — 1000 이상은 소수점 없이 */
const tick = (v: number) =>
  Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

/**
 * 시간축 위에 여러 신호를 겹쳐 그린다.
 *
 * 점이 수만 개여도 가로 300 px 이라 다 그릴 수 없다. 칸마다 ★최솟값과 최댓값을 모두★
 * 남겨 띠로 칠한다 — 신호가 매끄러우면 얇은 선으로, 20 Hz 로 떨고 있으면 두꺼운 띠로
 * 보인다. 평균 한 점만 남기면 그 떨림이 통째로 사라져서, 정작 보려던 것을 못 보게 된다.
 */
export default function SignalChart({
  title,
  unit,
  t,
  signals,
  symmetric,
  zeroBased,
  guides,
  hoverIdx,
  onHover,
}: Props) {
  const n = t.length;

  const cols = useMemo(() => signals.map((s) => binned(s.values, n)), [signals, n]);

  const range = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const set of cols) {
      for (const c of set) {
        if (!c.ok) continue;
        if (c.min < lo) lo = c.min;
        if (c.max > hi) hi = c.max;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
    // ★기준선은 눈금을 넓히지 않는다★ ±40°(조향 상한)나 ±2 m(이탈 정지) 같은 기준은
    //   실제 값보다 훨씬 커서, 눈금에 넣으면 정작 볼 신호가 한 줄로 눌린다. 실측
    //   2026-08-12 기록에서 CTE 는 −0.70~0.29 m 인데 ±2 m 기준선 때문에 ±2.16 눈금이
    //   잡혀 그래프가 거의 직선으로 보였다. 기준선은 범위 안에 들 때만 그린다.
    if (symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6);
      return { lo: -m * 1.08, hi: m * 1.08 };
    }
    const pad = Math.max((hi - lo) * 0.08, 1e-6);
    // 0 이 바닥인 신호(속도·펄스)는 아래로 여백을 두지 않는다 — 음수 눈금이 뜨면
    // '뒤로 갔다'로 잘못 읽힌다.
    if (zeroBased) return { lo: Math.min(0, lo), hi: hi + pad };
    return { lo: lo - pad, hi: hi + pad };
  }, [cols, symmetric, zeroBased]);

  /** 눈금 안에 드는 기준선만 남긴다 — 밖에 있으면 선이 테두리에 붙어 뜻이 없다 */
  const shownGuides = (guides ?? []).filter((g) => g.at > range.lo && g.at < range.hi);

  const yOf = (v: number) =>
    PLOT_H - ((v - range.lo) / Math.max(range.hi - range.lo, 1e-9)) * PLOT_H;

  /** 위(max)로 갔다가 아래(min)로 되돌아오는 닫힌 띠 */
  const bandOf = (set: Col[]) => {
    const up: string[] = [];
    const down: string[] = [];
    set.forEach((c, x) => {
      up.push(`${x},${yOf(c.max).toFixed(1)}`);
      down.push(`${x},${yOf(c.min).toFixed(1)}`);
    });
    return `M${up.join(" L")} L${down.reverse().join(" L")} Z`;
  };

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const c = Math.round(((e.clientX - rect.left) / rect.width) * (W - 1));
    const col = cols[0]?.[Math.max(0, Math.min(W - 1, c))];
    onHover(col ? col.idx : null);
  };

  const hoverX = hoverIdx == null || n < 2 ? null : Math.round((hoverIdx / (n - 1)) * (W - 1));
  const zeroY = range.lo < 0 && range.hi > 0 ? yOf(0) : null;

  return (
    <div className="sig">
      <div className="sig-head">
        <b title={`${title} [${unit}]`}>
          {title} <span>[{unit}]</span>
        </b>
        <div className="sig-keys">
          {signals.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.color, opacity: s.dashed ? 0.55 : 1 }} />
              {s.label}
              {hoverIdx != null && (
                <em>{fmtAt(s.values[hoverIdx])}</em>
              )}
            </span>
          ))}
        </div>
      </div>
      <svg
        className="sigchart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={pick}
        // ★onPointerLeave 로 선택을 지우지 않는다★ 손을 떼거나 그래프 밖으로
        //   나가도 고른 지점이 남아야 아래 표의 값을 천천히 읽을 수 있다.
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      >
        {zeroY !== null && <line className="zero" x1="0" y1={zeroY} x2={W} y2={zeroY} />}
        {shownGuides.map((g) => (
          <line key={g.at} className="guide" x1="0" y1={yOf(g.at)} x2={W} y2={yOf(g.at)} />
        ))}

        {cols.map((set, i) => (
          <path
            key={signals[i].label}
            d={bandOf(set)}
            fill={signals[i].color}
            fillOpacity={signals[i].dashed ? 0.3 : 0.55}
            stroke={signals[i].color}
            strokeWidth={1}
            strokeOpacity={signals[i].dashed ? 0.6 : 0.95}
            strokeDasharray={signals[i].dashed ? "3 2" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hoverX !== null && <line className="cur" x1={hoverX} y1="0" x2={hoverX} y2={PLOT_H} />}

        <text x="2" y="9">
          {tick(range.hi)}
        </text>
        <text x="2" y={PLOT_H - 2}>
          {tick(range.lo)}
        </text>
        <text x={W - 2} y={H - 2} textAnchor="end">
          {(t[n - 1] ?? 0).toFixed(0)} s
        </text>
      </svg>
    </div>
  );
}

function fmtAt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}
