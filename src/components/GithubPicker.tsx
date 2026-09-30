import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GITHUB_SOURCES,
  PINNED_ROUTE,
  downloadGithubCsv,
  folderUrl,
  formatBytes,
  listGithubCsv,
  type GhFile,
  type GithubSource,
} from "../lib/github";

interface Props {
  /** 받아 온 CSV 를 넘긴다 — App 이 손으로 올린 파일과 같은 경로(addFiles)로 태운다 */
  onPick: (files: File[], errors: string[]) => void;
  onClose: () => void;
}

/** 이 용량을 넘겨 고르면 경고를 띄운다. ros2bag 은 한 파일이 8MB 까지 있고
 *  전부 고르면 122MB 라, 모르고 눌렀다가 한참 기다리는 일이 실제로 생긴다. */
const WARN_BYTES = 20 * 1024 * 1024;

type Cache = Record<string, GhFile[]>;

/**
 * GitHub 폴더에서 CSV 를 고르는 ★앱 안의 팝업★.
 *
 * 별도 창을 띄우지 않는다 — 새 창은 팝업 차단에 막히고, 고른 결과를 되돌려 받으려면
 * postMessage 같은 배관이 필요해진다. 여기서는 그냥 오버레이 한 겹이다.
 *
 * 목록은 ★열 때 한 번만★ 받아 캐시한다(익명 GitHub API 는 시간당 60회다).
 * 탭을 오가도 다시 부르지 않고, '새로고침' 을 눌렀을 때만 다시 받는다.
 */
export default function GithubPicker({ onPick, onClose }: Props) {
  const [source, setSource] = useState<GithubSource>(GITHUB_SOURCES[0]);
  const [cache, setCache] = useState<Cache>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 고른 것은 ★경로★ 로 들고 있다 — 탭을 옮겨도 선택이 유지되고, 두 폴더에 같은
   *  이름이 있어도 섞이지 않는다. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (src: GithubSource, force = false) => {
      if (!force && cache[src.key]) return;
      setLoading(true);
      setError(null);
      try {
        const files = await listGithubCsv(src);
        setCache((c) => ({ ...c, [src.key]: files }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [cache]
  );

  useEffect(() => {
    void load(source);
  }, [source, load]);

  // Esc 로 닫는다. ★내려받는 중에는 닫지 않는다★ — 중간에 사라지면 무엇이 올라갔는지
  //   알 수 없다. 대신 '취소' 버튼이 abort 를 건다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 떠날 때 받던 것이 있으면 끊는다(응답이 사라진 컴포넌트로 돌아오지 않게)
  useEffect(() => () => abortRef.current?.abort(), []);

  const all = cache[source.key] ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((f) => f.name.toLowerCase().includes(q)) : all;
  }, [all, query]);

  /** 고른 파일의 실체. ★캐시에 있는 폴더 전부★ 에서 모은다 — 탭을 옮겨 고른 것도
   *  같이 올라가야 하기 때문이다. */
  const pickedFiles = useMemo(() => {
    const out: GhFile[] = [];
    for (const list of Object.values(cache)) {
      for (const f of list) if (picked.has(f.path)) out.push(f);
    }
    return out;
  }, [cache, picked]);

  const pickedBytes = pickedFiles.reduce((s, f) => s + f.size, 0);

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allShownPicked = shown.length > 0 && shown.every((f) => picked.has(f.path));
  const toggleShown = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) for (const f of shown) next.delete(f.path);
      else for (const f of shown) next.add(f.path);
      return next;
    });

  const confirm = async () => {
    if (!pickedFiles.length || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy({ done: 0, total: pickedFiles.length });
    const { files, errors } = await downloadGithubCsv(
      pickedFiles,
      (done, total) => setBusy({ done, total }),
      ctrl.signal
    );
    abortRef.current = null;
    setBusy(null);
    if (ctrl.signal.aborted) return;   // 취소했다 — 아무것도 올리지 않는다
    onPick(files, errors);
    onClose();
  };

  return (
    <div
      className="ghveil"
      role="dialog"
      aria-modal="true"
      aria-label="GitHub 에서 CSV 선택"
      onClick={() => !busy && onClose()}
    >
      <div className="ghbox" onClick={(e) => e.stopPropagation()}>
        <header className="ghhead">
          <b>GitHub 에서 선택</b>
          <button type="button" className="mini" onClick={onClose} disabled={!!busy}>
            닫기
          </button>
        </header>

        <div className="ghtabs" role="tablist">
          {GITHUB_SOURCES.map((s) => {
            const n = (cache[s.key] ?? []).filter((f) => picked.has(f.path)).length;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={source.key === s.key}
                className={source.key === s.key ? "on" : undefined}
                onClick={() => setSource(s)}
                disabled={!!busy}
              >
                {s.label}
                {n > 0 && <span className="ghbadge">{n}</span>}
              </button>
            );
          })}
        </div>

        <p className="ghhint">
          {source.hint} ·{" "}
          <a href={folderUrl(source)} target="_blank" rel="noopener">
            GitHub 에서 보기
          </a>
        </p>

        <div className="ghtools">
          <input
            ref={searchRef}
            type="search"
            placeholder="이름으로 거르기 (예: 20260913, manual)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!!busy}
          />
          <button type="button" onClick={toggleShown} disabled={!shown.length || !!busy}>
            {allShownPicked ? "보이는 것 해제" : `보이는 것 모두 (${shown.length})`}
          </button>
        </div>

        <div className="ghlist">
          {loading && <p className="note">목록을 받는 중…</p>}
          {error && (
            <div className="note warn">
              {error}
              <button
                type="button"
                className="mini"
                onClick={() => void load(source, true)}
                style={{ marginLeft: 8 }}
              >
                다시 시도
              </button>
            </div>
          )}
          {!loading && !error && !shown.length && (
            <p className="note">
              {all.length ? "거른 결과가 없습니다." : "이 폴더에 CSV 가 없습니다."}
            </p>
          )}
          {shown.map((f) => (
            <label key={f.path} className={picked.has(f.path) ? "ghrow on" : "ghrow"}>
              <input
                type="checkbox"
                checked={picked.has(f.path)}
                onChange={() => toggle(f.path)}
                disabled={!!busy}
              />
              <span className="ghname">{f.name}</span>
              <span className="ghmeta">
                {f.name === PINNED_ROUTE && <i>본선 코스</i>}
                {f.stamp && <i>{f.stamp}</i>}
                {formatBytes(f.size)}
              </span>
            </label>
          ))}
        </div>

        <footer className="ghfoot">
          <span className="ghsum">
            {pickedFiles.length
              ? `${pickedFiles.length}개 · ${formatBytes(pickedBytes)}`
              : "고른 파일 없음"}
            {pickedBytes > WARN_BYTES && (
              <b className="ghwarn"> — 용량이 큽니다. 내려받는 데 시간이 걸립니다</b>
            )}
          </span>
          <div className="ghact">
            {picked.size > 0 && !busy && (
              <button type="button" className="mini" onClick={() => setPicked(new Set())}>
                선택 해제
              </button>
            )}
            {busy ? (
              <>
                <span className="ghprog">
                  받는 중 {busy.done}/{busy.total}
                </span>
                <button type="button" onClick={() => abortRef.current?.abort()}>
                  취소
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => void confirm()}
                disabled={!pickedFiles.length}
              >
                불러오기
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
