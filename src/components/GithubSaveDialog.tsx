import { useEffect, useMemo, useRef, useState } from "react";
import {
  GithubSaveError,
  SAVE_NAME_RE,
  SIMPLE_SOURCE,
  TOKEN_NEW_URL,
  folderUrl,
  formatBytes,
  getSessionToken,
  maskToken,
  saveGithubCsv,
  setSessionToken,
  type SaveResult,
} from "../lib/github";

interface Props {
  /** 제안하는 파일 이름 — routeFileName() 그대로 (route_YYYYMMDD_HHMMSS.csv) */
  name: string;
  /** CSV 본문 — toMappingCsv() 가 만든 것. ★로컬 다운로드와 같은 바이트★ */
  text: string;
  /** 화면과 커밋 메시지에 쓰는 요약 (예: "1,234점 · 308.50 m") */
  summary: string;
  onClose: () => void;
}

/** edit = 고치는 중 / saving = 보내는 중 / exists = 같은 이름이 있다 / done = 끝 */
type Phase = "edit" | "saving" | "exists" | "done";

/**
 * 궤적 생성 결과를 ★단순 기록 폴더(find_wc/gps_data)★ 에 커밋하는 팝업. [2026-10-08]
 *
 * ★토큰은 이 탭의 메모리에만★ 둔다(github.ts 머리말) — 그래서 새로고침하면 다시 묻는다.
 * ★성공한 토큰만★ 남긴다. 틀린 토큰(401)은 그 자리에서 버리고 다시 받는다.
 * ★같은 이름은 조용히 덮지 않는다★ — 422 가 오면 '이름 바꾸기 / 덮어쓰기' 를 사람이 고른다.
 *
 * 바깥(어두운 막)을 눌러도 닫지 않는다 — 붙여 넣은 토큰이 실수 한 번에 날아가지 않게.
 * 닫기·취소·Esc 로만 닫는다. 보내는 중에는 그것도 막는다(무엇이 올라갔는지 모르게 된다).
 */
export default function GithubSaveDialog({ name: initialName, text, summary, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const [token, setToken] = useState<string | null>(getSessionToken());
  const [tokenInput, setTokenInput] = useState("");
  const [phase, setPhase] = useState<Phase>("edit");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const nameOk = SAVE_NAME_RE.test(name);
  const useToken = token ?? (tokenInput.trim() || null);
  const busy = phase === "saving";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "saving") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  // 처음 열릴 때 손이 갈 칸에 커서를 둔다 — 토큰이 없으면 토큰, 있으면 이름
  useEffect(() => {
    (getSessionToken() ? nameRef : tokenRef).current?.focus();
  }, []);

  const save = async (overwrite = false) => {
    if (!useToken || !nameOk || busy) return;
    const t = useToken;
    setPhase("saving");
    setError(null);
    try {
      const r = await saveGithubCsv(name, text, `궤적 생성: ${name} (${summary})`, t, { overwrite });
      setSessionToken(t);
      setToken(t);
      setTokenInput("");
      setResult(r);
      setPhase("done");
    } catch (e) {
      const err = e instanceof GithubSaveError ? e : new GithubSaveError("other", String(e));
      if (err.kind === "auth") {
        setSessionToken(null);
        setToken(null);
        setTokenInput("");
      }
      setError(err.message);
      setPhase(err.kind === "exists" ? "exists" : "edit");
      if (err.kind === "auth") setTimeout(() => tokenRef.current?.focus(), 0);
    }
  };

  const forgetToken = () => {
    setSessionToken(null);
    setToken(null);
    setTimeout(() => tokenRef.current?.focus(), 0);
  };

  const rename = () => {
    setPhase("edit");
    setError(null);
    setTimeout(() => {
      const el = nameRef.current;
      if (!el) return;
      el.focus();
      // 확장자 앞까지만 골라 둔다 — 대개 뒤에 _2 같은 것을 붙인다
      el.setSelectionRange(0, Math.max(0, el.value.length - 4));
    }, 0);
  };

  return (
    <div className="ghveil" role="dialog" aria-modal="true" aria-label="GitHub 에 저장">
      <form
        className="ghbox narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (phase === "edit") void save();
        }}
      >
        <header className="ghhead">
          <b>GitHub 에 저장</b>
          <button type="button" className="mini" onClick={onClose} disabled={busy}>
            닫기
          </button>
        </header>

        {phase === "done" && result ? (
          <div className="ghsave">
            <p className="ghok">저장했습니다</p>
            <p className="ghsize">
              <code>{result.file.path}</code> · {formatBytes(result.file.size)}
            </p>
            <p className="note">
              <a href={result.htmlUrl} target="_blank" rel="noopener">
                GitHub 에서 보기
              </a>
              {result.commitUrl && (
                <>
                  {" · "}
                  <a href={result.commitUrl} target="_blank" rel="noopener">
                    커밋
                  </a>
                </>
              )}
            </p>
            <p className="note">
              <b>GitHub 에서 선택 → 단순 기록</b> 에서 바로 다시 열 수 있습니다.
            </p>
          </div>
        ) : (
          <div className="ghsave">
            <p className="ghhint">
              저장 위치 ·{" "}
              <a href={folderUrl(SIMPLE_SOURCE)} target="_blank" rel="noopener">
                {SIMPLE_SOURCE.owner}/{SIMPLE_SOURCE.repo} / {SIMPLE_SOURCE.path}
              </a>{" "}
              — 'GitHub 에서 선택 → 단순 기록' 에 나타납니다
            </p>
            <p className="note">
              <b>공개 리포입니다</b> — 저장한 좌표는 누구나 볼 수 있습니다.
            </p>

            <label className="ghfield">
              <span>파일 이름</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value.trim());
                  if (phase === "exists") {
                    setPhase("edit");
                    setError(null);
                  }
                }}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {!nameOk ? (
              <p className="note warn">영문·숫자·. _ - 만 쓰고 .csv 로 끝나야 합니다.</p>
            ) : (
              !name.startsWith("route_") && (
                <p className="note">
                  차량 prompt 는 <code>route_</code> 로 시작하는 파일만 목록에 띄웁니다 — 나중에 차로
                  옮길 경로라면 <code>route_</code> 로 두세요.
                </p>
              )
            )}
            <p className="ghsize">
              {summary} · {formatBytes(bytes)}
            </p>

            {token ? (
              <div className="ghtok">
                <span>
                  토큰 <code>{maskToken(token)}</code> · 이 탭에만 있음
                </span>
                <button type="button" className="mini" onClick={forgetToken} disabled={busy}>
                  토큰 지우기
                </button>
              </div>
            ) : (
              <>
                <label className="ghfield">
                  <span>GitHub 토큰</span>
                  <input
                    ref={tokenRef}
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="github_pat_…"
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <p className="note">
                  <a href={TOKEN_NEW_URL} target="_blank" rel="noopener">
                    토큰 만들기
                  </a>{" "}
                  — 이름·기한·<b>Contents: Read and write</b> 는 채워져 열립니다.{" "}
                  <b>Repository access</b> 에서 <code>Only select repositories</code> →{" "}
                  <code>cheongbaek/find_wc</code> 하나만 고르세요.
                </p>
                <p className="note">
                  토큰은 <b>이 탭의 메모리에만</b> 둡니다(쿠키·브라우저 저장소에 남기지 않음) —
                  새로고침하면 다시 넣어야 합니다.
                </p>
              </>
            )}

            {error && <p className="note warn">{error}</p>}
          </div>
        )}

        <footer className="ghfoot">
          <div className="ghact">
            {phase === "done" ? (
              <button type="button" className="primary" onClick={onClose}>
                닫기
              </button>
            ) : phase === "exists" ? (
              <>
                <button type="button" onClick={rename}>
                  이름 바꾸기
                </button>
                <button type="button" className="danger" onClick={() => void save(true)}>
                  덮어쓰기
                </button>
              </>
            ) : (
              <>
                {busy && <span className="ghprog">저장 중…</span>}
                <button type="button" onClick={onClose} disabled={busy}>
                  취소
                </button>
                <button type="submit" className="primary" disabled={busy || !nameOk || !useToken}>
                  저장
                </button>
              </>
            )}
          </div>
        </footer>
      </form>
    </div>
  );
}
