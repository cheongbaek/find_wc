import { useMemo } from "react";
import SignalChart, { type Signal } from "./SignalChart";
import type { ControlSeries } from "../lib/csv";
import {
  CTE_DEVIATION_M,
  CTE_I_MAX_DEG,
  MS_PER_PULSE,
  ROAD_MAX_DEG,
  STEER_MAX_DEG,
  STEER_PLANT_GAIN,
  STEER_UNDERSTEER,
  WHEELBASE_M,
  pulseKmh,
  rebuildSteer,
} from "../lib/control";

interface Props {
  control: ControlSeries;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}

/** 짝을 이루는 신호는 같은 색 계열로 — 지령이 진하고 실측이 연하다 */
const C_CMD = "#2f7bff";
const C_MEAS = "#00c2ff";
const C_REBUILT = "#ffd60a";
const C_CTE = "#ff3b30";
const C_I = "#ff9500";
const C_PP = "#7c5cff";
const C_GPS = "#30d158";
const C_ENC = "#8e8e93";

const num = (v: number, d = 2) => v.toFixed(d);

/** 두 신호의 차이 통계. 값이 둘 다 있는 표본만 센다 */
function residual(a: (number | null)[] | undefined, b: (number | null)[] | undefined) {
  if (!a || !b) return null;
  let sum = 0;
  let sq = 0;
  let max = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = x - y;
    sum += d;
    sq += d * d;
    if (Math.abs(d) > max) max = Math.abs(d);
    n++;
  }
  return n ? { bias: sum / n, rms: Math.sqrt(sq / n), max, n } : null;
}

export default function ControlPanel({ control, hoverIdx, onHover }: Props) {
  const { t, cols } = control;

  // ── 조향 지령 재현 ─────────────────────────────────────────────────────
  // driving.py 가 그 시점에 쓴 입력(α · 목표거리 · CTE 적분 · 지령펄스)만으로 같은
  // 계산을 다시 돌린다. ★결과가 cmd_steer_deg 와 겹치면 로직이 도는 것★ 이고,
  // 벌어지면 둘 중 하나다 — 제어가 예상과 다르게 동작했거나, lib/control.ts 의
  // 상수가 차량 코드보다 낡았거나.
  const rebuilt = useMemo(() => {
    const { alpha, targetDist, cteITerm, cmdPulse } = cols;
    if (!alpha || !targetDist || !cmdPulse) return null;
    const pot: (number | null)[] = [];
    const pp: (number | null)[] = [];
    const cteRoad: (number | null)[] = [];
    for (let i = 0; i < t.length; i++) {
      const a = alpha[i];
      const d = targetDist[i];
      const p = cmdPulse[i];
      if (a == null || d == null || p == null || d <= 0) {
        pot.push(null);
        pp.push(null);
        cteRoad.push(null);
        continue;
      }
      const b = rebuildSteer(a, d, cteITerm?.[i] ?? 0, p);
      pot.push(b.pot);
      pp.push(b.ppRoad * STEER_PLANT_GAIN); // pot 기준으로 맞춰야 지령과 겹쳐 읽힌다
      cteRoad.push(b.cteRoad * STEER_PLANT_GAIN);
    }
    return { pot, pp, cteRoad };
  }, [cols, t.length]);

  const steerFollow = residual(cols.measSteer, cols.cmdSteer);
  const rebuildErr = residual(cols.cmdSteer, rebuilt?.pot);

  // 조향 부드러움 — 지령의 변화율과 부호반전 횟수. 헌팅하면 둘 다 커진다.
  const smooth = useMemo(() => {
    const s = cols.cmdSteer;
    const dt = control.periodS;
    if (!s || !dt) return null;
    let sq = 0;
    let n = 0;
    let flips = 0;
    let prevSign = 0;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1];
      const b = s[i];
      if (a == null || b == null) continue;
      sq += ((b - a) / dt) ** 2;
      n++;
      // 불감대 ±1° 밖에서 부호가 실제로 넘어간 것만 센다(0 근처 잡음 무시)
      const sign = b > 1 ? 1 : b < -1 ? -1 : 0;
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) flips++;
        prevSign = sign;
      }
    }
    const dur = t[t.length - 1] - t[0];
    return n
      ? { rate: Math.sqrt(sq / n), flipsPerMin: dur > 0 ? (flips / dur) * 60 : 0 }
      : null;
  }, [cols.cmdSteer, control.periodS, t]);

  const has = (name: keyof typeof cols) => Boolean(cols[name]?.some((v) => v != null));

  // ── 그래프 묶음 ────────────────────────────────────────────────────────
  const steerSignals: Signal[] = [];
  if (has("cmdSteer")) steerSignals.push({ label: "지령", color: C_CMD, values: cols.cmdSteer! });
  if (has("measSteer"))
    steerSignals.push({ label: "실측", color: C_MEAS, values: cols.measSteer!, dashed: true });
  if (rebuilt) steerSignals.push({ label: "재현", color: C_REBUILT, values: rebuilt.pot, dashed: true });

  const splitSignals: Signal[] = [];
  if (rebuilt) {
    splitSignals.push({ label: "순수추종", color: C_PP, values: rebuilt.pp });
    if (has("cteITerm"))
      splitSignals.push({ label: "CTE 적분", color: C_I, values: rebuilt.cteRoad });
  }

  //  속도는 ★펄스 계열★ 로 낸다. meas_pulse 가 실측이고(2026-08-12 기록에서 GPS
  //  주행거리를 1.00배로 재현했다), cmd_pulse 는 지령이다. 둘이 벌어진 구간이
  //  '시켰는데 안 굴렀다'이고, 저속 펄스 보정이 붙는 자리다.
  const asKmh = (v: (number | null)[]) => v.map((x) => (x == null ? null : pulseKmh(x)));
  const speedSignals: Signal[] = [];
  if (has("gpsKmh")) speedSignals.push({ label: "GPS", color: C_GPS, values: cols.gpsKmh! });
  if (has("measPulse"))
    speedSignals.push({ label: "실측", color: C_MEAS, values: asKmh(cols.measPulse!) });
  if (has("cmdPulse"))
    speedSignals.push({ label: "지령", color: C_CMD, values: asKmh(cols.cmdPulse!), dashed: true });

  //  저속 펄스 보정 검증 — out ≠ ref 인 구간이 보정이 걸린 구간이다(record.py 주석)
  const pulseSignals: Signal[] = [];
  if (has("refPulse")) pulseSignals.push({ label: "ref", color: C_ENC, values: cols.refPulse! });
  if (has("outPulse")) pulseSignals.push({ label: "out", color: C_CMD, values: cols.outPulse! });
  if (has("measPulse"))
    pulseSignals.push({ label: "meas", color: C_MEAS, values: cols.measPulse!, dashed: true });

  const inputSignals: Signal[] = [];
  if (has("alpha")) inputSignals.push({ label: "α", color: C_PP, values: cols.alpha! });

  return (
    <div className="ctrl">
      <p className="axis">
        제어 진단 — {control.t.length.toLocaleString()}행
        {control.periodS ? ` · ${(1 / control.periodS).toFixed(0)} Hz` : ""} · 가로축 t_rel
      </p>
      <p className="note">
        부호 규약 — 조향·α 는 <b>+오른쪽 / −왼쪽</b>(α 만 +왼쪽), CTE 는{" "}
        <b>+경로 왼쪽 / −오른쪽</b>. 노란 점선은 기준값(조향 ±{STEER_MAX_DEG}° 상한, CTE ±
        {CTE_DEVIATION_M} m 이탈 정지, 적분 ±{(CTE_I_MAX_DEG * STEER_PLANT_GAIN).toFixed(1)}° 상한)이며,
        <b>눈금 안에 들 때만</b> 보입니다.
      </p>

      {steerSignals.length > 0 && (
        <SignalChart
          title="조향 pot 지령각"
          unit="deg"
          t={t}
          signals={steerSignals}
          symmetric
          guides={[{ at: STEER_MAX_DEG }, { at: -STEER_MAX_DEG }]}
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {splitSignals.length > 0 && (
        <SignalChart
          title="지령 분해 (pot 기준)"
          unit="deg"
          t={t}
          signals={splitSignals}
          symmetric
          guides={[
            { at: CTE_I_MAX_DEG * STEER_PLANT_GAIN },
            { at: -CTE_I_MAX_DEG * STEER_PLANT_GAIN },
          ]}
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {has("cte") && (
        <SignalChart
          title="경로 오차 cte_m"
          unit="m"
          t={t}
          signals={[{ label: "CTE", color: C_CTE, values: cols.cte! }]}
          symmetric
          guides={[{ at: CTE_DEVIATION_M }, { at: -CTE_DEVIATION_M }]}
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {has("cteIntegral") && (
        <SignalChart
          title="CTE 적분 상태"
          unit="m·s"
          t={t}
          signals={[{ label: "∫CTE", color: C_I, values: cols.cteIntegral! }]}
          symmetric
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {speedSignals.length > 0 && (
        <SignalChart
          title="속도"
          unit="km/h"
          t={t}
          signals={speedSignals}
          zeroBased
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {pulseSignals.length > 0 && (
        <SignalChart
          title="구동 펄스"
          unit="펄스"
          t={t}
          signals={pulseSignals}
          zeroBased
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {inputSignals.length > 0 && (
        <SignalChart
          title="순수추종 방위 α"
          unit="deg"
          t={t}
          signals={inputSignals}
          symmetric
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      {has("targetDist") && (
        <SignalChart
          title="선행거리"
          unit="m"
          t={t}
          signals={[{ label: "d", color: C_MEAS, values: cols.targetDist! }]}
          zeroBased
          hoverIdx={hoverIdx}
          onHover={onHover}
        />
      )}

      <table className="stats">
        <tbody>
          {steerFollow && (
            <>
              <tr className="sec">
                <th colSpan={2}>조향 추종 — 실측이 지령을 얼마나 따라갔나</th>
              </tr>
              <tr>
                <th>오차 RMS</th>
                <td>{num(steerFollow.rms)}°</td>
              </tr>
              <tr>
                <th>치우침(실측−지령)</th>
                <td>{num(steerFollow.bias)}°</td>
              </tr>
              <tr>
                <th>최대 오차</th>
                <td>{num(steerFollow.max, 1)}°</td>
              </tr>
            </>
          )}

          {smooth && (
            <>
              <tr className="sec">
                <th colSpan={2}>조향 부드러움 — 값이 크면 헌팅이다</th>
              </tr>
              <tr>
                <th>변화율 RMS</th>
                <td>{num(smooth.rate, 1)}°/s</td>
              </tr>
              <tr>
                <th>좌우 반전</th>
                <td>{num(smooth.flipsPerMin, 1)}회/분</td>
              </tr>
            </>
          )}

          {rebuildErr && (
            <>
              <tr className="sec">
                <th colSpan={2}>지령 재현 검산 — 0 에 가까울수록 로직이 그대로 돈 것</th>
              </tr>
              <tr>
                <th>잔차 RMS</th>
                <td>{num(rebuildErr.rms)}°</td>
              </tr>
              <tr>
                <th>최대 잔차</th>
                <td>{num(rebuildErr.max, 1)}°</td>
              </tr>
              <tr>
                <th>비교한 표본</th>
                <td>{rebuildErr.n.toLocaleString()}개</td>
              </tr>
              <tr>
                <th>쓴 상수</th>
                <td>
                  L {WHEELBASE_M} · 링키지 {STEER_PLANT_GAIN} · 언더스티어 {STEER_UNDERSTEER}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      {has("encoder") && (
        <p className="note warn">
          <b>encoder_sum 은 속도로 바꾸지 않았습니다.</b> ENC_SUM_TO_PULSE(0.5)×0.884 로
          환산하면 2026-08-12 기록에서 주행거리가 GPS 의 <b>9.4배</b>로 나옵니다(31.8%의 행이
          물리 상한을 넘고, 1초짜리 덩어리라 중앙값 필터로도 안 지워집니다). 그 빌드의
          /encoder 가 어떤 계측창인지 확인되기 전까지 실측 속도로는 <b>meas_pulse</b> 를
          씁니다 — 같은 기록에서 GPS 주행거리를 1.00배로 재현했습니다.
        </p>
      )}
      {rebuildErr && (
        <p className="note">
          재현은 α·선행거리·CTE 적분·지령펄스만으로 driving.py 의 조향 계산을 다시 돌린 값입니다.
          잔차가 크면 제어가 이상한 것일 수도, 위 상수가 차량 코드보다 낡은 것일 수도 있습니다.
          종점 근처는 원식의 분모가 달라져(LFD 가 CSV 에 없습니다) 잔차가 커지는 것이 정상입니다.
        </p>
      )}
      <p className="note">
        조향 두 열은 <b>pot 지령각</b>이지 도로휠각이 아닙니다 — 도로휠각 ≈ pot ÷ {STEER_PLANT_GAIN}{" "}
        (상한 {ROAD_MAX_DEG.toFixed(1)}°). 지령 펄스 1 = {MS_PER_PULSE} m/s.
      </p>
    </div>
  );
}
