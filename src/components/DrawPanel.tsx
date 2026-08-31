import type { LatLng } from "../lib/geo";
import { DEFAULT_SPACING_M } from "../lib/route";

export interface DrawInfo {
  active: boolean;
  pts: LatLng[];
  vertices: LatLng[];
  spacing: number;
  lengthM: number;
  /** 커서가 격자에서 당겨진 거리 [m] — 지금 클릭하면 얼마나 옮겨 붙는가 */
  pullM: number | null;
  /** 지정 완료된 궤적이 손에 있는가 = 내려받을 수 있는가 */
  ready: boolean;
}

interface Props {
  info: DrawInfo;
  onToggle: () => void;
  onSpacing: (m: number) => void;
  onUndo: () => void;
  onReset: () => void;
  onDownload: () => void;
}

/** 고를 수 있는 간격 [m]. 0.25 는 mapping.py 의 SPACING_M 이다 */
const SPACINGS = [0.1, 0.25, 0.5, 1];

export default function DrawPanel({
  info,
  onToggle,
  onSpacing,
  onUndo,
  onReset,
  onDownload,
}: Props) {
  const { active, pts, vertices, spacing, lengthM, pullM, ready } = info;

  return (
    <div className="draw">
      <div className="row">
        <button type="button" className={active ? "on" : undefined} onClick={onToggle}>
          {active ? "매핑 종료" : "매핑 시작"}
        </button>
        <button
          type="button"
          className="icon"
          disabled={!ready}
          onClick={onDownload}
          title={ready ? "route_*.csv 로 내려받기" : "지정을 마치면 내려받을 수 있습니다"}
          aria-label="CSV 내려받기"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path
              d="M12 3v11m0 0 4-4m-4 4-4-4M4 19h16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <label className="field">
        <span>매핑 간격</span>
        <select
          value={String(spacing)}
          disabled={active}
          onChange={(e) => onSpacing(Number(e.target.value))}
          title={active ? "매핑 중에는 바꿀 수 없습니다 — 격자가 어긋납니다" : undefined}
        >
          {SPACINGS.map((v) => (
            <option key={v} value={String(v)}>
              {v} m{v === DEFAULT_SPACING_M ? " (차량 기본값)" : ""}
            </option>
          ))}
        </select>
      </label>

      {active ? (
        <>
          <p className="note">
            <b>좌클릭</b> 점 찍기 · <b>끌기</b> 지도 이동 · <b>Backspace</b> 직전 구간 지우기 ·{" "}
            <b>ESC/우클릭</b> 지정 완료
          </p>
          <div className="row">
            <button type="button" onClick={onUndo} disabled={!vertices.length}>
              직전 구간 지우기
            </button>
            <button type="button" className="danger" onClick={onReset} disabled={!pts.length}>
              처음부터
            </button>
          </div>
        </>
      ) : (
        <p className="note">
          위성 영상 위를 클릭해 경로를 그립니다. 클릭 지점은 <b>직전 점에서 {spacing} m 의 정수배</b>
          자리로 당겨 붙고, 그 사이는 같은 간격으로 자동 보간됩니다(직선만).
        </p>
      )}

      <table className="stats">
        <tbody>
          <tr className="sec">
            <th colSpan={2}>{active ? "그리는 중" : ready ? "지정 완료" : "궤적 생성"}</th>
          </tr>
          <tr>
            <th>점</th>
            <td>
              {pts.length.toLocaleString()}개 (클릭 {vertices.length})
            </td>
          </tr>
          <tr>
            <th>길이</th>
            <td>{lengthM.toFixed(2)} m</td>
          </tr>
          {active && (
            <tr>
              <th>격자로 당김</th>
              <td>{pullM == null ? "—" : `${pullM.toFixed(3)} m`}</td>
            </tr>
          )}
        </tbody>
      </table>

      {ready && (
        <p className="note">
          내려받는 파일 이름은 <code>route_</code> 로 시작합니다 — 차량의 경로 목록(prompt.py)이 그
          접두어로만 파일을 거르기 때문입니다. 실계측 열(wheel_pulse 등)은 <b>비어 있습니다</b>:
          이 파일에는 측정이 없습니다.
        </p>
      )}
    </div>
  );
}
