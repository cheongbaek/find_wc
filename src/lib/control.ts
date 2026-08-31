// 제어 로직 검산 — driving.py 가 낸 조향 지령을 CSV 만으로 다시 만들어 본다.
//
// ★왜 필요한가★ 로그에 남는 것은 '무엇을 내보냈나'(cmd_steer_deg)뿐이다. 그것이
// 순수추종 공식이 요구한 값인지, CTE 적분이 얹힌 값인지, 아니면 어딘가 어긋난
// 값인지는 남지 않는다. 그런데 그 계산에 들어간 입력이 전부 같은 CSV 에 있으므로
// ★여기서 다시 계산해 실제 지령과 비교하면★ 로직이 도는지 아닌지가 숫자로 나온다.
//
// ⚠️ ★아래 상수는 white1/driving.py 의 복제본이다 — 단일 소유자는 그쪽이다★
//   차량 코드에서 이 값이 바뀌면 이 화면의 검산이 조용히 틀린다. 재현 잔차가
//   갑자기 커지면 제어가 이상해진 것이 아니라 ★이 표가 낡은 것★ 일 수 있다.
//   그래서 화면에 상수를 그대로 보여 주고, 잔차와 나란히 읽게 한다.

/** [m] 축거. 순수추종 조향각이 여기에 정비례한다 (driving.py WHEELBASE_M) */
export const WHEELBASE_M = 1.25;
/** pot 지령 / 도로휠각 — 링키지비 실측 (driving.py STEER_PLANT_GAIN) */
export const STEER_PLANT_GAIN = 1.26;
/** [deg/(m/s²)] 언더스티어 계수 (driving.py STEER_UNDERSTEER) */
export const STEER_UNDERSTEER = 5.17;
/** [deg] B보드 수용 상한 (driving.py STEER_MAX_DEG) */
export const STEER_MAX_DEG = 40;
/** [m/s] 바퀴 하나 기준 1펄스 (driving.py MS_PER_PULSE) */
export const MS_PER_PULSE = 0.884;
/** [m] 이만큼 벗어나면 driving 이 즉시 정지한다 (driving.py CTE_DEVIATION_M) */
export const CTE_DEVIATION_M = 2.0;
/** [deg] CTE 적분이 도로휠각에 더할 수 있는 상한 (driving.py CTE_I_MAX_DEG) */
export const CTE_I_MAX_DEG = 2.5;

/** 도로휠각 상한 = pot 상한 ÷ 링키지비. 이 값이 최소회전반경을 정한다 */
export const ROAD_MAX_DEG = STEER_MAX_DEG / STEER_PLANT_GAIN;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const clamp = (v: number, lim: number) => (v > lim ? lim : v < -lim ? -lim : v);

/**
 * 순수추종이 요구한 ★도로휠각★ [deg].  (driving.py pure_pursuit_steer)
 *
 *     δ = −atan( 2·L·sin α / d )
 *
 * α(heading_err_deg)는 ★헤딩 오차가 아니라★ 선행 목표점의 차체기준 방위다
 * (+ 왼쪽). 부호를 뒤집는 것은 B보드가 −를 좌회전으로 받기 때문이다.
 *
 * ⚠️ 원식의 분모는 max(LFD·0.5, d) 인데 ★LFD 자체는 CSV 에 없다★. 목표점은 LFD
 *   이상 앞에서 고르므로 d ≥ LFD 가 보통이고 그때 분모는 d 다. 둘이 갈리는 것은
 *   종점 근처(목표가 LFD 보다 가까이 붙는 구간)뿐이라, 그 구간의 잔차만 커진다.
 */
export function purePursuitRoadDeg(alphaDeg: number, targetDistM: number): number {
  const denom = Math.max(targetDistM, 1e-6);
  const steer = -R2D * Math.atan2(2 * WHEELBASE_M * Math.sin(alphaDeg * D2R), denom);
  return clamp(steer, ROAD_MAX_DEG);
}

/**
 * 도로휠각 → B보드 pot 지령 [deg].  (driving.py steer_command)
 *
 *     pot = plant_gain·δ + understeer·v²/R,   R = L/tan δ
 *
 * 둘째 항이 언더스티어 보정이다 — 같은 반경이라도 빠르면 더 꺾어야 한다.
 */
export function potFromRoadDeg(roadDeg: number, vMs: number): number {
  const d = Math.abs(roadDeg);
  if (d < 1e-6) return 0;
  const pot =
    STEER_PLANT_GAIN * d +
    (STEER_UNDERSTEER * vMs * vMs * Math.tan(d * D2R)) / WHEELBASE_M;
  return Math.sign(roadDeg) * Math.min(STEER_MAX_DEG, pot);
}

/** 한 시점의 조향 지령 분해 — 각 항이 몇 도씩 기여했는지 */
export interface SteerBreakdown {
  /** 순수추종이 낸 도로휠각 [deg] */
  ppRoad: number;
  /** CTE 적분이 더한 도로휠각 [deg] */
  cteRoad: number;
  /** 둘을 더해 상한으로 자른 도로휠각 [deg] */
  road: number;
  /** 링키지비만 적용한 pot [deg] — 언더스티어 항을 분리해 보기 위한 중간값 */
  potLinkage: number;
  /** 언더스티어 항이 더한 pot [deg] */
  potUndersteer: number;
  /** 재현한 최종 pot 지령 [deg] */
  pot: number;
}

/**
 * 조향 지령을 처음부터 다시 만든다. driving.py run_follow() 의 이 세 줄과 같다:
 *     road  = pure_pursuit_steer(lfd)
 *     road  = apply_cte_integral(road, cte)
 *     steer = steer_command(road, pulse · MS_PER_PULSE)
 *
 * 속도는 ★지령 펄스★ 로 낸다 — 실측이 아니라 그 시점에 driving 이 믿은 값이라야
 * 같은 계산을 재현한다.
 */
export function rebuildSteer(
  alphaDeg: number,
  targetDistM: number,
  cteITermDeg: number,
  cmdPulse: number
): SteerBreakdown {
  const ppRoad = purePursuitRoadDeg(alphaDeg, targetDistM);
  const cteRoad = clamp(cteITermDeg, CTE_I_MAX_DEG);
  const road = clamp(ppRoad + cteRoad, ROAD_MAX_DEG);
  const vMs = cmdPulse * MS_PER_PULSE;

  const pot = potFromRoadDeg(road, vMs);
  const potLinkage = Math.sign(road) * STEER_PLANT_GAIN * Math.abs(road);
  return {
    ppRoad,
    cteRoad,
    road,
    potLinkage,
    potUndersteer: pot - potLinkage,
    pot,
  };
}

/**
 * 펄스 → 속도 [km/h]. ★바퀴 하나 기준 펄스★ 에만 쓴다 (cmd_pulse · meas_pulse · ref/out).
 *
 * ⚠️ ★encoder_sum 에는 쓰지 말 것★ 이름과 상수(ENC_SUM_TO_PULSE 0.5)만 보면
 *   encoder_sum/2 가 바퀴 하나 기준 펄스일 것 같지만, 실측 기록에서는 맞지 않았다:
 *
 *     2026-08-12 기록(3,222행 / 161초 / GPS 실주행 163.6 m) 적분 결과
 *       meas_pulse   × 0.884  →  164.0 m   ★GPS 대비 1.00배 — 이것이 실측 속도다★
 *       encoder_sum/2× 0.884  → 1542.3 m   GPS 대비 9.43배
 *       cmd_pulse    × 0.884  →  383.8 m   2.35배 (지령이므로 안 맞는 것이 정상)
 *
 *   즉 그 빌드의 /encoder 는 이 환산이 가정한 계측창(20 ms)의 값이 아니다. 무엇인지
 *   확인되기 전까지 ★encoder_sum 을 속도로 바꾸지 않는다★. 31.8%의 행이 물리 상한을
 *   넘고 그것이 1초짜리 덩어리로 이어져 있어서, 중앙값 필터로 지울 수 있는 단발
 *   스파이크도 아니다(3·5·7·9점 모두 그대로 남았다).
 */
export function pulseKmh(pulse: number): number {
  return pulse * MS_PER_PULSE * 3.6;
}
