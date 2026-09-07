import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ControlPanel from "./components/ControlPanel";
import DrawPanel from "./components/DrawPanel";
import ErrorProfile from "./components/ErrorProfile";
import MapView, { type ColorMode, type MapTrack, type MapType } from "./components/MapView";
import StatsPanel, { type StatSection } from "./components/StatsPanel";
import TrackList, { type TrackRow } from "./components/TrackList";
import { useKakaoLoader } from "./hooks/useKakaoLoader";
import { pulseKmh } from "./lib/control";
import { takeInboundCsv } from "./lib/inbound";
import {
  DEFAULT_SPACING_M,
  download,
  extend,
  routeFileName,
  snapToGrid,
  toMappingCsv,
  totalLength,
} from "./lib/route";
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

type Tab = "compare" | "draw";

/**
 * 그래프에서 고른 지점. ★어느 그래프에서 골랐는지를 함께 든다★
 *
 * 오차 그래프는 지도 점(hold 병합 후) 번호이고 제어 그래프는 전 행 번호라
 * 번호 공간이 다르다. 원본을 기억해 두고 반대쪽은 ★시각(t_rel)으로 환산★ 한다 —
 * 그래야 어느 쪽을 긁어도 나머지가 같은 순간을 가리킨다.
 */
interface Sel {
  src: "profile" | "control";
  idx: number;
}

export default function App() {
  const kakao = useKakaoLoader();

  const [tab, setTab] = useState<Tab>("compare");
  const [collapsed, setCollapsed] = useState(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [mapType, setMapType] = useState<MapType>("sat");
  const [colorMode, setColorMode] = useState<ColorMode>("solid");
  const [errMaxChoice, setErrMaxChoice] = useState<number | "auto">(1);
  const [refId, setRefId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 궤적 생성 상태 ─────────────────────────────────────────────────────
  //  pts 가 산출물(보간 포함)이고 vertices 는 사용자가 실제로 누른 자리다. segLens 는
  //  ★클릭 한 번이 몇 점을 붙였는지★ — Backspace 가 그만큼만 되돌리기 위해 든다.
  const [drawActive, setDrawActive] = useState(false);
  const [drawPts, setDrawPts] = useState<LatLng[]>([]);
  const [drawVertices, setDrawVertices] = useState<LatLng[]>([]);
  const [segLens, setSegLens] = useState<number[]>([]);
  const [spacing, setSpacing] = useState(DEFAULT_SPACING_M);
  const [rawCursor, setRawCursor] = useState<LatLng | null>(null);

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

  // ── 안드로이드 매핑 앱이 링크로 넘긴 CSV 자동 적재 ──────────────────────
  // 앱의 목록에서 CSV 를 고르면 이 주소가 #csvgz=… 를 달고 열린다(lib/inbound.ts).
  // 사용자가 '파일 선택'을 다시 누르지 않아도 그 파일이 곧바로 지도에 올라간다.
  // 프래그먼트가 없으면(=앱의 '매핑 확인' 버튼으로 그냥 들어온 경우) 아무 일도
  // 하지 않는다 — 빈 화면에서 사용자가 직접 올리는 종전 흐름 그대로다.
  useEffect(() => {
    void (async () => {
      try {
        const inbound = await takeInboundCsv();
        if (!inbound) return;
        // File 로 감싸 기존 경로(addFiles)를 그대로 태운다 — 유형 판별·색 배정·
        // 통계가 손으로 올린 파일과 완전히 같은 길을 지나게 하는 것이 목적이다.
        await addFiles([new File([inbound.text], inbound.name, { type: "text/csv" })]);
      } catch (e) {
        setNotes([`링크로 받은 CSV 를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`]);
      }
    })();
  }, [addFiles]);

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
    setSel(null);
    setNotes([]);
  };

  const clearAll = () => {
    setTracks([]);
    setRefId(null);
    setSelectedId(null);
    setSel(null);
    setNotes([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── 궤적 생성 ──────────────────────────────────────────────────────────

  /** 지금 클릭하면 찍힐 자리. 첫 점은 격자가 없으므로 커서 그대로다. */
  const snap = useMemo(() => {
    if (!drawActive || !rawCursor) return null;
    const last = drawPts[drawPts.length - 1];
    if (!last) return { at: rawCursor, steps: 0, distM: 0, pullM: 0 };
    return snapToGrid(last, rawCursor, spacing);
  }, [drawActive, rawCursor, drawPts, spacing]);

  //  ★상태 갱신 함수 안에서 다른 상태를 세우지 않는다★ React 가 updater 를
  //  두 번 부르면(StrictMode) 점이 두 번 붙는다. 셋을 나란히 세운다.
  const handleDrawClick = useCallback(
    (at: LatLng) => {
      const last = drawPts[drawPts.length - 1];
      if (!last) {
        // 첫 점 — 여기가 격자의 원점이 된다. 당길 직전 점이 없으니 클릭 그대로 찍는다.
        setDrawPts([at]);
        setDrawVertices([at]);
        setSegLens([1]);
        return;
      }
      const seg = extend(last, at, spacing);
      setDrawPts((p) => [...p, ...seg.pts]);
      setDrawVertices((v) => [...v, seg.snap.at]);
      setSegLens((l) => [...l, seg.pts.length]);
    },
    [drawPts, spacing]
  );

  /** ★직전 '클릭'을 되돌린다★ 보간점 하나만 지우는 것은 뜻이 없다 — 격자가 어긋난다 */
  const undoVertex = useCallback(() => {
    if (!segLens.length) return;
    const drop = segLens[segLens.length - 1];
    setDrawPts((p) => p.slice(0, Math.max(0, p.length - drop)));
    setDrawVertices((v) => v.slice(0, -1));
    setSegLens((l) => l.slice(0, -1));
  }, [segLens]);

  const finishDraw = useCallback(() => {
    setDrawActive(false);
    setRawCursor(null);
  }, []);

  const resetDraw = useCallback(() => {
    setDrawPts([]);
    setDrawVertices([]);
    setSegLens([]);
    setRawCursor(null);
  }, []);

  /** 시작/종료 한 버튼. ★한 번에 하나만★ 이라 새로 시작하면 앞의 것은 사라진다 */
  const toggleDraw = useCallback(() => {
    if (drawActive) {
      finishDraw();
      return;
    }
    if (drawPts.length >= 2 && !window.confirm("그려 둔 궤적을 지우고 새로 시작할까요?")) return;
    resetDraw();
    setDrawActive(true);
  }, [drawActive, drawPts.length, finishDraw, resetDraw]);

  // ESC = 지정 완료 / Backspace = 직전 구간 지우기 (카카오 '거리 재기'와 같은 손버릇)
  useEffect(() => {
    if (!drawActive) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        finishDraw();
      } else if (e.key === "Backspace") {
        e.preventDefault(); // 막지 않으면 브라우저가 뒤로 가기를 한다
        undoVertex();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawActive, finishDraw, undoVertex]);

  const saveRoute = useCallback(() => {
    if (drawPts.length < 2) return;
    download(routeFileName(), toMappingCsv(drawPts));
  }, [drawPts]);

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
   *
   * ★둘 다 없어도 null 을 돌려주지 않는다★ [추가]
   *   그릴 세로축이 없다고 막대까지 없애면 ★지점을 고를 길이 사라진다★ — 정밀도·상태
   *   열이 없는 CSV(매핑 파일, 2026-08-12 이전 기록)에서 위경도를 못 읽던 것이 그
   *   이유였다. 값은 null 로 넘기고(없는 것을 0 으로 채우지 않는다) 가로축만 살려,
   *   긁으면 그 지점의 위경도가 아래 표에 뜨게 한다.
   */
  const series = useMemo(() => {
    if (!target) return null;
    if (target.err) {
      return { values: target.err, max: errMax, topLabel: `${errMax} m`, kind: "err" as const };
    }
    const sigma = target.track.parsed.sigma;
    if (sigma) {
      const values = sigma.map((v) => v ?? 0);
      const peak = Math.max(...values, 0.02);
      return {
        values,
        max: peak,
        topLabel: peak < 1 ? `σ ${fmt(peak * 100, 0)} cm` : `σ ${fmt(peak)} m`,
        kind: "sigma" as const,
      };
    }
    return { values: null, max: 1, topLabel: "", kind: "none" as const };
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

  /**
   * 고른 지점을 두 번호 공간 양쪽으로 환산한다.
   * 시각이 1초 넘게 벌어지면 같은 순간이라 할 수 없으므로 그쪽은 비운다.
   */
  const picked = useMemo(() => {
    if (!sel || !target) return null;
    const { parsed } = target.track;
    const ptsT = parsed.extras.t ?? null;
    const ctrlT = parsed.control?.t ?? null;

    const nearest = (times: (number | null)[], want: number) => {
      let best: number | null = null;
      let gap = Infinity;
      for (let i = 0; i < times.length; i++) {
        const v = times[i];
        if (v == null) continue;
        const d = Math.abs(v - want);
        if (d < gap) {
          gap = d;
          best = i;
        }
      }
      return gap <= 1 ? best : null;
    };

    if (sel.src === "profile") {
      const p = Math.min(sel.idx, parsed.pts.length - 1);
      const want = ptsT?.[p];
      return { pts: p, ctrl: want != null && ctrlT ? nearest(ctrlT, want) : null };
    }
    const c = Math.min(sel.idx, (ctrlT?.length ?? 1) - 1);
    const want = ctrlT?.[c];
    return { pts: want != null && ptsT ? nearest(ptsT, want) : null, ctrl: c };
  }, [sel, target]);

  const mapIdx = picked?.pts ?? null;
  const cursor: LatLng | null =
    mapIdx != null && target ? target.track.parsed.pts[mapIdx] ?? null : null;

  /**
   * 고른 지점의 값들. ★CSV 에 적힌 위경도를 원문 그대로 맨 위에 둔다★ —
   * 다른 도구와 대조하려면 자릿수까지 같아야 하기 때문이다.
   */
  const pickRows = useMemo(() => {
    if (!target || !picked) return null;
    const { parsed } = target.track;
    const rows: { label: string; value: string }[] = [];
    const p = picked.pts;

    if (p != null) {
      rows.push({ label: "위도", value: parsed.rawLat[p] || fmt(parsed.pts[p].lat, 8) });
      rows.push({ label: "경도", value: parsed.rawLon[p] || fmt(parsed.pts[p].lng, 8) });
      const t = parsed.extras.t?.[p];
      if (t != null) rows.push({ label: "t_rel", value: `${fmt(t, 2)} s` });
      if (target.err) rows.push({ label: "벗어난 거리", value: `${fmt(target.err[p])} m` });
      if (parsed.quality) {
        rows.push({
          label: "GPS 등급",
          value: QUALITY_LABEL[parsed.quality[p]].replace(/ \(.*\)$/, ""),
        });
      }
      const sg = parsed.sigma?.[p];
      if (sg != null) {
        rows.push({ label: "σ", value: sg < 1 ? `${fmt(sg * 100, 1)} cm` : `${fmt(sg)} m` });
      }
    }

    const c = picked.ctrl;
    const cols = parsed.control?.cols;
    if (c != null && cols) {
      const at = (name: keyof typeof cols) => cols[name]?.[c] ?? null;
      const add = (label: string, v: number | null, unit: string, d = 2) => {
        if (v != null && Number.isFinite(v)) rows.push({ label, value: `${fmt(v, d)}${unit}` });
      };
      add("경로오차 cte_m", at("cte"), " m", 3);
      add("적분 ∫CTE", at("cteIntegral"), " m·s", 3);
      add("적분 기여", at("cteITerm"), "°");
      add("조향 지령", at("cmdSteer"), "°");
      add("조향 실측", at("measSteer"), "°");
      add("목표 방위 α", at("alpha"), "°");
      add("선행거리", at("targetDist"), " m");
      const meas = at("measPulse");
      if (meas != null) add("속도(실측)", pulseKmh(meas), " km/h", 1);
      const cmd = at("cmdPulse");
      if (cmd != null) add("속도(지령)", pulseKmh(cmd), " km/h", 1);
      add("GPS 속도", at("gpsKmh"), " km/h", 1);
    }
    return rows.length ? rows : null;
  }, [target, picked]);

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
          draw={
            tab === "draw" && (drawActive || drawPts.length)
              ? {
                  // ★보여 주기와 입력 받기를 갈라 둔다★ 종료 뒤에도 그린 궤적은
                  //   지도에 남지만 클릭은 먹지 않아야 한다 (DrawState.active 주석)
                  active: drawActive,
                  pts: drawPts,
                  vertices: drawVertices,
                  cursor: drawActive ? rawCursor : null,
                  preview: drawActive ? snap?.at ?? null : null,
                }
              : null
          }
          onDrawClick={handleDrawClick}
          onDrawMove={setRawCursor}
          onDrawFinish={finishDraw}
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

      <aside className={`panel${collapsed ? " collapsed" : ""}`}>
        <header>
          <div className="tabs" role="tablist">
            {(
              [
                ["compare", "궤적 비교"],
                ["draw", "궤적 생성"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? "on" : undefined}
                onClick={() => {
                  setTab(value);
                  setCollapsed(false); // 탭을 눌렀으면 보고 싶다는 뜻이다
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="fold"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "펼치기" : "접기"}
            aria-label={collapsed ? "패널 펼치기" : "패널 접기"}
            aria-expanded={!collapsed}
          >
            {collapsed ? "\u2228" : "\u2212"}
          </button>
        </header>

        {!collapsed && tab === "draw" && (
          <div className="scroll">
            <DrawPanel
              info={{
                active: drawActive,
                pts: drawPts,
                vertices: drawVertices,
                spacing,
                lengthM: drawPts.length >= 2 ? totalLength(drawPts) : 0,
                pullM: snap && drawPts.length ? snap.pullM : null,
                ready: !drawActive && drawPts.length >= 2,
              }}
              onToggle={toggleDraw}
              onSpacing={setSpacing}
              onUndo={undoVertex}
              onReset={resetDraw}
              onDownload={saveRoute}
            />
          </div>
        )}

        {!collapsed && tab === "compare" && (
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
                {series.kind === "err"
                  ? "세로축: 벗어난 거리"
                  : series.kind === "sigma"
                    ? "세로축: GPS 표준편차 σ"
                    : "그릴 값 없음 — 가로축: 주행거리(지점 고르기)"}{" "}
                · {target.track.name}
              </p>
              <ErrorProfile
                values={series.values}
                dist={target.dist}
                valueMax={series.max}
                topLabel={series.topLabel}
                quality={target.track.parsed.quality}
                hoverIdx={picked?.pts ?? null}
                onHover={(i) => setSel(i == null ? null : { src: "profile", idx: i })}
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
              {pickRows ? (
                <table className="stats pick">
                  <tbody>
                    <tr className="sec">
                      <th>선택 지점</th>
                      <td>
                        <button type="button" className="mini" onClick={() => setSel(null)}>
                          해제
                        </button>
                      </td>
                    </tr>
                    {pickRows.map((r) => (
                      <tr key={r.label}>
                        <th>{r.label}</th>
                        <td>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="readout">
                  {series.kind === "none"
                    ? "GPS 정밀도·상태 열이 없어 그래프는 비어 있습니다. 그래도 막대를 끌면 그 지점의 위경도가 나옵니다."
                    : "그래프를 끌어 지점을 고르세요. 손을 떼도 그 값이 남습니다."}
                </p>
              )}
            </>
          )}
          {target?.track.parsed.qualityNote && (
            <p className="note warn">{target.track.parsed.qualityNote}</p>
          )}

          <StatsPanel sections={sections} />

          {target?.track.parsed.control && (
            <ControlPanel
              control={target.track.parsed.control}
              hoverIdx={picked?.ctrl ?? null}
              onHover={(i) => setSel(i == null ? null : { src: "control", idx: i })}
            />
          )}
        </div>
        )}

        {/* 접지 않았을 때만 — 도구에서 소개·방침으로 나가는 유일한 통로다.
            정적 페이지(about.html/privacy.html)라 크롤러도 그대로 따라간다. */}
        {!collapsed && (
          <div className="panel-foot">
            <a href="about.html">사용법</a>
            <a href="../privacy.html">개인정보처리방침</a>
            <a href="https://github.com/cheongbaek/find_wc" target="_blank" rel="noopener">
              소스
            </a>
          </div>
        )}
      </aside>

      {dragging && <div className="dropveil">여기에 놓으세요</div>}
    </div>
  );
}
