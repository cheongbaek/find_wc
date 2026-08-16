import type { TrackKind } from "../lib/csv";

export interface TrackRow {
  id: string;
  name: string;
  kind: TrackKind;
  kindLabel: string;
  color: string;
  visible: boolean;
  points: number;
  lengthM: number;
  /** 어느 열을 읽었는지 + 걸러낸 행 — 유형 판별이 틀렸는지 여기서 바로 보인다 */
  detail: string;
  isRef: boolean;
  isSelected: boolean;
}

interface Props {
  rows: TrackRow[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onSetRef: (id: string) => void;
  onSelect: (id: string) => void;
}

export default function TrackList({ rows, onToggle, onRemove, onSetRef, onSelect }: Props) {
  return (
    <ul className="tracks">
      {rows.map((row) => (
        <li key={row.id} className={row.isSelected ? "on" : undefined}>
          <input
            type="checkbox"
            checked={row.visible}
            onChange={() => onToggle(row.id)}
            aria-label={`${row.name} 표시`}
          />
          <span className="swatch" style={{ background: row.color }} />
          <button
            type="button"
            className="name"
            onClick={() => onSelect(row.id)}
            title="이 궤적을 오차 그래프 대상으로 선택"
          >
            <b>
              {row.name}
              <em className={`badge k-${row.kind}`}>{row.kindLabel}</em>
              {row.isRef && <em className="badge ref">기준</em>}
            </b>
            <small>
              {row.points.toLocaleString()}점 · {row.lengthM.toFixed(1)} m · {row.detail}
            </small>
          </button>
          {row.kind === "mapping" && !row.isRef && (
            <button
              type="button"
              className="mini"
              onClick={() => onSetRef(row.id)}
              title="오차 계산의 기준 궤적으로 삼는다"
            >
              기준
            </button>
          )}
          <button
            type="button"
            className="mini danger"
            onClick={() => onRemove(row.id)}
            title="이 궤적만 지운다"
          >
            지우기
          </button>
        </li>
      ))}
    </ul>
  );
}
