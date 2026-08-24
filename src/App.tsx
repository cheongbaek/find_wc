import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorProfile from "./components/ErrorProfile";
import MapView, { type ColorMode, type MapTrack, type MapType } from "./components/MapView";
import StatsPanel, { type StatSection } from "./components/StatsPanel";
import TrackList, { type TrackRow } from "./components/TrackList";
import { useKakaoLoader } from "./hooks/useKakaoLoader";
import {
  KIND_LABEL,
  QUALITY_LABEL,
  readTrackFile,
  type ParsedTrack,
  type Quality,
} from "./lib/csv";
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
/** 오차 눈금 선택지. "auto" 는 데이터에 맞춰 스스로 정한다 */
const ERR_MAX_CHOICES: (number | "auto")[] = ["auto", 0.5, 1, 2, 5];

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
  const [errMaxChoice, setErrMaxChoice] = useState<number | "auto">(1);
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

  // 아래 그래프의 대상 궤적.
  // ★매핑 기준이 없어도 잡는다★ — 주행 CSV 만 올려도 GPS 품질은 볼 수 있어야 한다.
  const target = useMemo(() => {
    if (!analysis) return null;
    const measured = analysis.visible.filter((t) => analysis.errors.has(t.id));
    const pool = measured.length
      ? measured
      : analysis.visible.filter((t) => t.parsed.kind !== "mapping");
    const candidates = pool.length ? pool : analysis.visible;
    const picked = candidates.find((t) => t.id === selectedId) ?? candidates[0];
    if (!picked) return null;
    const err = analysis.errors.get(picked.id) ?? null;
    return {
      track: picked,
      err,
      dist: cumulative(analysis.geom.get(picked.id)!.xy),
      stats: err ? quantiles(err) : null,
    };
  }, [analysis, selectedId]);

  /**
   * 오차 눈금.
   * ★자동★ 이면 95% 값을 올림해 잡는다 — 다른 경로를 달린 기록을 얹어도 그래프가
   * 위쪽에 붙어 뭉개지지 않는다(실측에서 15 m 오차가 1 m 눈금에 꽉 차 버렸다).
   */
  const errMax = useMemo(() => {
    if (errMaxChoice !== "auto") return errMaxChoice;
    const stats = target?.stats;
    if (!stats) return 1;
    return Math.max(0.1, Math.ceil(stats.p95 * 10) / 10);
  }, [errMaxChoice, target]);

  /**
   * 그래프에 그릴 값.
   * 매핑 기준이 있으면 ★벗어난 거리★, 없으면 ★GPS 표준편차 σ★ 를 그린다.
   * 어느 쪽이든 아래 띠에는 정밀도 등급이 깔린다.
   */
  const series = useMemo(() => {
    if (!target) return null;
    if (target.err) {
      return { values: target.err, max: errMax, topLabel: `${errMax} m`, kind: "err" as const };
    }
    const sigma = target.track.parsed.sigma;
    if (!sigma) return null;
    const values = sigma.map((v) => v ?? 0);
    const peak = Math.max(...values, 0.02);
    return {
      values,
      max: peak,
      topLabel: peak < 1 ? `σ ${fmt(peak * 100, 0)} cm` : `σ ${fmt(peak)} m`,
      kind: "sigma" as const,
    };
  }, [target, errMax]);

  const mapTracks: MapTrack[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.visible.map((track) => ({
      id: track.id,
      color: track.color,
      pts: track.parsed.pts,
      err: analysis.errors.get(track.id) ?? null,
      quality: track.parsed.quality,
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
    if (!analysis || !target) return [];
    const recGeom = analysis.geom.get(target.track.id)!;
    const out: StatSection[] = [];

    if (target.stats) {
      out.push({
        title: `벗어난 거리 — ${target.track.name}`,
        rows: statRows(target.stats),
      });
    }
    // 매핑 기준이 있을 때만 낼 수 있는 것들
    const refGeom = analysis.ref ? analysis.geom.get(analysis.ref.id)! : null;
    if (refGeom) out.push({
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

    // GPS 품질 — 오차가 제어 탓인지 GPS 탓인지 가르는 근거다.
    const { quality, qualitySource, statusSummary, sigma } = target.track.parsed;
    if (quality) {
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      const counts: Record<Quality, number> = { high: 0, mid: 0, low: 0 };
      const distances: Record<Quality, number> = { high: 0, mid: 0, low: 0 };
      quality.forEach((level, i) => {
        counts[level]++;
        if (i > 0) distances[level] += target.dist[i] - target.dist[i - 1];
      });

      // 등급마다 한 줄 — 비율·거리에 (오차를 잴 수 있으면) 평균 오차까지 붙인다
      const levelRows = (["high", "mid", "low"] as Quality[])
        .filter((level) => counts[level] > 0)
        .map((level) => {
          const share = `${fmt((counts[level] / quality.length) * 100, 1)}% · ${fmt(distances[level], 1)} m`;
          const picked = target.err?.filter((_, i) => quality[i] === level) ?? [];
          return {
            label: QUALITY_LABEL[level],
            value: picked.length ? `${share} · 오차 ${fmt(mean(picked))} m` : share,
          };
        });

      if (statusSummary) levelRows.push({ label: "기록된 상태값", value: statusSummary });
      const sigmaValues = sigma?.filter((v): v is number => v !== null) ?? [];
      if (sigmaValues.length) {
        const lo = Math.min(...sigmaValues);
        const hi = Math.max(...sigmaValues);
        levelRows.push({
          label: "σ 범위",
          value: hi < 1 ? `${fmt(lo * 100, 1)}~${fmt(hi * 100, 1)} cm` : `${fmt(lo)}~${fmt(hi)} m`,
        });
      }

      out.push({ title: `GPS 품질 — 판정 근거 ${qualitySource}`, rows: levelRows });
    }

    // 주행 기록에 차량이 스스로 계산해 남긴 횡오차(cte_m)가 있으면 대조한다.
    // 여기 화면이 계산한 값과 맞아떨어지면 "이 그림을 믿어도 된다"는 근거가 된다.
    const measuredErr = target.err;
    const cte = measuredErr ? target.track.parsed.extras.cte : null;
    if (cte && measuredErr) {
      let sum = 0;
      let max = 0;
      let n = 0;
      for (let i = 0; i < measuredErr.length; i++) {
        const v = cte[i];
        if (v == null) continue;
        const gap = Math.abs(Math.abs(v) - measuredErr[i]);
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
    const { extras, quality, sigma } = target.track.parsed;
    const parts: string[] = [];
    if (target.err) parts.push(`벗어남 ${fmt(target.err[hoverIdx])} m`);
    parts.push(`${fmt(target.dist[hoverIdx], 0)} m 지점`);
    const t = extras.t?.[hoverIdx];
    const speed = extras.speed?.[hoverIdx];
    if (t != null) parts.push(`t=${fmt(t, 1)} s`);
    if (speed != null) parts.push(`${fmt(speed, 1)} km/h`);
    if (quality) parts.push(QUALITY_LABEL[quality[hoverIdx]].replace(/ \(.*\)$/, ""));
    const s = sigma?.[hoverIdx];
    if (s != null) parts.push(s < 1 ? `σ ${fmt(s * 100, 1)} cm` : `σ ${fmt(s)} m`);
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
                  value={String(errMaxChoice)}
                  onChange={(e) =>
                    setErrMaxChoice(e.target.value === "auto" ? "auto" : Number(e.target.value))
                  }
                  title="오차 색과 그래프의 최대 눈금"
                >
                  {ERR_MAX_CHOICES.map((v) => (
                    <option key={String(v)} value={String(v)}>
                      {v === "auto" ? `자동 (${fmt(errMax, 1)} m)` : `최대 ${v} m`}
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

          {target && series && (
            <>
              <p className="axis">
                {series.kind === "err" ? "세로축: 벗어난 거리" : "세로축: GPS 표준편차 σ"} ·{" "}
                {target.track.name}
              </p>
              <ErrorProfile
                values={series.values}
                dist={target.dist}
                valueMax={series.max}
                topLabel={series.topLabel}
                quality={target.track.parsed.quality}
                hoverIdx={hoverIdx}
                onHover={setHoverIdx}
              />
              {target.track.parsed.quality && (
                <div className="legend rtk">
                  <i className="sw high" />
                  <span>RTK 고정급</span>
                  <i className="sw mid" />
                  <span>중간</span>
                  <i className="sw low" />
                  <span>낮음</span>
                </div>
              )}
              <p className="readout">{readout}</p>
            </>
          )}
          {target?.track.parsed.qualityNote && (
            <p className="note warn">{target.track.parsed.qualityNote}</p>
          )}

          <StatsPanel sections={sections} />
        </div>
      </aside>

      {dragging && <div className="dropveil">여기에 놓으세요</div>}
    </div>
  );
}
