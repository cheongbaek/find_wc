import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorProfile from "./components/ErrorProfile";
import MapView, { type ColorMode, type MapTrack, type MapType } from "./components/MapView";
import StatsPanel, { type StatSection } from "./components/StatsPanel";
import TrackList, { type TrackRow } from "./components/TrackList";
import { useKakaoLoader } from "./hooks/useKakaoLoader";
import { KIND_LABEL, readTrackFile, type ParsedTrack } from "./lib/csv";
import {
  crossTrack,
  cumulative,
  pathLength,
  quantiles,
  toLocal,
  type LatLng,
  type Quantiles,
} from "./lib/geo";

interface Track {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  parsed: ParsedTrack;
}

// 매핑은 파랑 계열, 주행은 빨강 계열 — 여러 판을 올려도 계열로 구분된다
const MAPPING_COLORS = ["#2f7bff", "#00c2ff", "#7c5cff"];
const RECORD_COLORS = ["#ff3b30", "#ff9500", "#ff2d95"];
const ERR_MAX_CHOICES = [0.5, 1, 2, 5];

const fmt = (v: number, digits = 2) => v.toFixed(digits);

function statRows(q: Quantiles, unit = "m") {
  return [
    { label: "평균", value: `${fmt(q.mean)} ${unit}` },
    { label: "중앙값", value: `${fmt(q.p50)} ${unit}` },
    { label: "95%", value: `${fmt(q.p95)} ${unit}` },
    { label: "최대", value: `${fmt(q.max)} ${unit}` },
  ];
}

export default function App() {
  const kakao = useKakaoLoader();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [mapType, setMapType] = useState<MapType>("sat");
  const [colorMode, setColorMode] = useState<ColorMode>("solid");
  const [errMax, setErrMax] = useState(1);
  const [refId, setRefId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 파일 받기 ──────────────────────────────────────────────────────────
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => /\.(csv|txt)$/i.test(f.name));
    if (!list.length) {
      setNotes(["CSV 파일이 아닙니다. .csv 파일을 올려 주세요."]);
      return;
    }
    setBusy(true);
    const added: Track[] = [];
    const messages: string[] = [];

    for (const file of list) {
      try {
        const parsed = await readTrackFile(file);
        added.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          color: "",
          visible: true,
          parsed,
        });
        if (parsed.kind === "unknown") {
          messages.push(
            `${file.name}: 유형을 확정하지 못해 ${parsed.latColumn}/${parsed.lonColumn} 열로 그렸습니다.`
          );
        }
      } catch (e) {
        messages.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (added.length) {
      setTracks((prev) => {
        // 색은 ★같은 유형끼리 순서대로★ 돌려 쓴다
        const next = [...prev];
        for (const track of added) {
          const palette = track.parsed.kind === "record" ? RECORD_COLORS : MAPPING_COLORS;
          const used = next.filter((t) => t.parsed.kind === track.parsed.kind).length;
          next.push({ ...track, color: palette[used % palette.length] });
        }
        return next;
      });
      setFitToken((n) => n + 1);
    }
    setNotes(messages);
    setBusy(false);
  }, []);

  // 창 전체가 드롭 영역이다 — 파일을 어디에 떨어뜨려도 받는다
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setDragging(false);
      void addFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  // ── 지우기 ─────────────────────────────────────────────────────────────
  const removeTrack = (id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    setRefId((cur) => (cur === id ? null : cur));
    setSelectedId((cur) => (cur === id ? null : cur));
    setHoverIdx(null);
    setNotes([]);
  };

  const clearAll = () => {
    setTracks([]);
    setRefId(null);
    setSelectedId(null);
    setHoverIdx(null);
    setNotes([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── 계산 ───────────────────────────────────────────────────────────────
  const analysis = useMemo(() => {
    const visible = tracks.filter((t) => t.visible && t.parsed.pts.length >= 2);
    if (!visible.length) return null;

    // 원점은 매핑 궤적의 첫 점 — 모든 궤적을 같은 평면에 올려야 비교가 된다
    const mappings = visible.filter((t) => t.parsed.kind === "mapping");
    const origin = (mappings[0] ?? visible[0]).parsed.pts[0];

    const geom = new Map(
      visible.map((track) => {
        const xy = toLocal(track.parsed.pts, origin);
        return [track.id, { xy, lengthM: pathLength(xy) }];
      })
    );

    const ref = mappings.find((t) => t.id === refId) ?? mappings[0] ?? null;
    const refXY = ref ? geom.get(ref.id)!.xy : null;

    const errors = new Map<string, number[]>();
    if (refXY) {
      visible
        .filter((t) => t.parsed.kind !== "mapping")
        .forEach((track) => errors.set(track.id, crossTrack(geom.get(track.id)!.xy, refXY)));
    }

    return { visible, geom, ref, errors };
  }, [tracks, refId]);

  // 오차 그래프 대상: 사용자가 고른 주행 궤적, 없으면 첫 주행 궤적
  const target = useMemo(() => {
    if (!analysis) return null;
    const candidates = analysis.visible.filter((t) => analysis.errors.has(t.id));
    const picked = candidates.find((t) => t.id === selectedId) ?? candidates[0];
    if (!picked) return null;
    const err = analysis.errors.get(picked.id)!;
    return {
      track: picked,
      err,
      dist: cumulative(analysis.geom.get(picked.id)!.xy),
      stats: quantiles(err),
    };
  }, [analysis, selectedId]);

  const mapTracks: MapTrack[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.visible.map((track) => ({
      id: track.id,
      label: KIND_LABEL[track.parsed.kind],
      color: track.color,
      pts: track.parsed.pts,
      err: analysis.errors.get(track.id) ?? null,
    }));
  }, [analysis]);

  const rows: TrackRow[] = tracks.map((track) => {
    const geom = analysis?.geom.get(track.id);
    const { parsed } = track;
    const dropped =
      parsed.skippedRows + parsed.mergedRows > 0
        ? ` · ${(parsed.skippedRows + parsed.mergedRows).toLocaleString()}행 제외`
        : "";
    return {
      id: track.id,
      name: track.name,
      kind: parsed.kind,
      kindLabel: KIND_LABEL[parsed.kind],
      color: track.color,
      visible: track.visible,
      points: parsed.pts.length,
      lengthM: geom?.lengthM ?? 0,
      detail: `${parsed.latColumn}/${parsed.lonColumn}${dropped}`,
      isRef: analysis?.ref?.id === track.id,
      isSelected: target?.track.id === track.id,
    };
  });

  const sections: StatSection[] = useMemo(() => {
    if (!analysis || !target || !analysis.ref) return [];
    const refGeom = analysis.geom.get(analysis.ref.id)!;
    const recGeom = analysis.geom.get(target.track.id)!;
    const out: StatSection[] = [];

    if (target.stats) {
      out.push({
        title: `벗어난 거리 — ${target.track.name}`,
        rows: statRows(target.stats),
      });
    }
    out.push({
      title: "궤적 비교",
      rows: [
        { label: "매핑 길이", value: `${fmt(refGeom.lengthM, 1)} m` },
        { label: "주행 길이", value: `${fmt(recGeom.lengthM, 1)} m` },
        {
          label: "출발점 간격",
          value: `${fmt(
            Math.hypot(
              recGeom.xy[0].x - refGeom.xy[0].x,
              recGeom.xy[0].y - refGeom.xy[0].y
            )
          )} m`,
        },
        {
          label: "도착점 간격",
          value: `${fmt(
            Math.hypot(
              recGeom.xy[recGeom.xy.length - 1].x - refGeom.xy[refGeom.xy.length - 1].x,
              recGeom.xy[recGeom.xy.length - 1].y - refGeom.xy[refGeom.xy.length - 1].y
            )
          )} m`,
        },
      ],
    });

    // 주행 기록에 차량이 스스로 계산해 남긴 횡오차(cte_m)가 있으면 대조한다.
    // 여기 화면이 계산한 값과 맞아떨어지면 "이 그림을 믿어도 된다"는 근거가 된다.
    const cte = target.track.parsed.extras.cte;
    if (cte) {
      let sum = 0;
      let max = 0;
      let n = 0;
      for (let i = 0; i < target.err.length; i++) {
        const v = cte[i];
        if (v == null) continue;
        const gap = Math.abs(Math.abs(v) - target.err[i]);
        sum += gap;
        max = Math.max(max, gap);
        n++;
      }
      if (n) {
        out.push({
          title: "차량 기록값(cte_m)과 대조",
          rows: [
            { label: "평균 차이", value: `${fmt(sum / n, 3)} m` },
            { label: "최대 차이", value: `${fmt(max, 3)} m` },
            { label: "비교한 점", value: `${n.toLocaleString()}개` },
          ],
        });
      }
    }
    return out;
  }, [analysis, target]);

  const cursor: LatLng | null =
    hoverIdx != null && target ? target.track.parsed.pts[hoverIdx] ?? null : null;

  const readout = (() => {
    if (!target || hoverIdx == null) return "그래프에 마우스를 올리면 그 지점이 지도에 표시됩니다.";
    const { extras } = target.track.parsed;
    const parts = [`벗어남 ${fmt(target.err[hoverIdx])} m`, `${fmt(target.dist[hoverIdx], 0)} m 지점`];
    const t = extras.t?.[hoverIdx];
    const speed = extras.speed?.[hoverIdx];
    if (t != null) parts.push(`t=${fmt(t, 1)} s`);
    if (speed != null) parts.push(`${fmt(speed, 1)} km/h`);
    return parts.join(" · ");
  })();

  const hasError = tracks.some((t) => analysis?.errors.has(t.id));
  const padLeft = typeof window !== "undefined" && window.innerWidth > 720 ? 380 : 48;

  return (
    <div className={`app${dragging ? " dragging" : ""}`}>
      {kakao === "ready" ? (
        <MapView
          tracks={mapTracks}
          mapType={mapType}
          colorMode={hasError ? colorMode : "solid"}
          errMax={errMax}
          cursor={cursor}
          fitToken={fitToken}
          padLeft={padLeft}
        />
      ) : (
        <div className="map placeholder">
          {kakao === "loading" && "카카오맵을 불러오는 중…"}
          {kakao === "no-key" && (
            <p>
              <b>VITE_KAKAO_JS_KEY 가 없습니다.</b>
              <br />
              <code>.env</code> 파일에 카카오 JavaScript 키를 넣고 개발 서버를 다시 시작하세요.
            </p>
          )}
          {kakao === "error" && (
            <p>
              <b>카카오맵 SDK를 불러오지 못했습니다.</b>
              <br />
              개발자 콘솔의 플랫폼 &gt; Web 에 <code>http://localhost:5173</code> 이 등록돼 있는지
              확인하세요.
            </p>
          )}
        </div>
      )}

      <aside className="panel">
        <header>
          <h1>궤적 비교</h1>
          <span className="sub">매핑 vs 주행</span>
        </header>

        <div className="scroll">
          <div
            className="drop"
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
          >
            <b>CSV 파일을 끌어다 놓으세요</b>
            <small>매핑(latitude/longitude) · 주행(fix_lat/fix_lon) 을 자동으로 구분합니다</small>
            <span className="btn">파일 선택</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = ""; // 같은 파일을 다시 올릴 수 있게 비운다
              }}
            />
          </div>

          {busy && <p className="note">읽는 중…</p>}
          {notes.map((note) => (
            <p className="note warn" key={note}>
              {note}
            </p>
          ))}

          {tracks.length > 0 && (
            <>
              <TrackList
                rows={rows}
                onToggle={(id) =>
                  setTracks((prev) =>
                    prev.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t))
                  )
                }
                onRemove={removeTrack}
                onSetRef={setRefId}
                onSelect={setSelectedId}
              />
              <div className="row">
                <button type="button" onClick={() => setFitToken((n) => n + 1)}>
                  전체 보기
                </button>
                <button type="button" className="danger" onClick={clearAll}>
                  모두 지우기
                </button>
              </div>
            </>
          )}

          <div className="row seg">
            {(
              [
                ["sat", "위성"],
                ["hybrid", "위성+도로"],
                ["road", "일반"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={mapType === value ? "on" : undefined}
                onClick={() => setMapType(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {hasError && (
            <>
              <div className="row seg">
                <button
                  type="button"
                  className={colorMode === "solid" ? "on" : undefined}
                  onClick={() => setColorMode("solid")}
                >
                  단색
                </button>
                <button
                  type="button"
                  className={colorMode === "err" ? "on" : undefined}
                  onClick={() => setColorMode("err")}
                >
                  오차 색
                </button>
                <select
                  value={errMax}
                  onChange={(e) => setErrMax(Number(e.target.value))}
                  title="오차 색과 그래프의 최대 눈금"
                >
                  {ERR_MAX_CHOICES.map((v) => (
                    <option key={v} value={v}>
                      최대 {v} m
                    </option>
                  ))}
                </select>
              </div>
              {colorMode === "err" && (
                <div className="legend">
                  <span>0 m</span>
                  <i className="bar" />
                  <span>{errMax} m 이상</span>
                </div>
              )}
            </>
          )}

          {target && (
            <>
              <ErrorProfile
                err={target.err}
                dist={target.dist}
                errMax={errMax}
                hoverIdx={hoverIdx}
                onHover={setHoverIdx}
              />
              <p className="readout">{readout}</p>
            </>
          )}

          <StatsPanel sections={sections} />
        </div>
      </aside>

      {dragging && <div className="dropveil">여기에 놓으세요</div>}
    </div>
  );
}
