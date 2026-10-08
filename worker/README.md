# find_wc 저장 서버 (Cloudflare Worker)

사이트의 **궤적 생성 → 내려받기 아이콘 → GitHub 에 저장** 을 방문자가 **아무 절차 없이** 쓰게 하는 중계 서버다.

```
브라우저 ──(CSV)──▶ 저장 서버 (이 Worker, 토큰은 여기 비밀값에만) ──▶ cheongbaek/find_wc/gps_data
```

사이트는 정적 파일이라 쓰기 토큰을 품을 수 없다(번들에 넣으면 누구나 꺼내 리포를 고친다).
그래서 토큰은 **이 서버의 비밀값 `GITHUB_TOKEN` 에만** 두고, 브라우저는 CSV 만 보낸다.
저장 서버 주소가 사이트에 연결되기 전에는 'GitHub 에 저장' 이 종전처럼 토큰을 묻는다.

## 처음 한 번 — 설치 (약 15분)

### 1. 웹용 GitHub 토큰 만들기

[토큰 만들기 — find_wc-save-worker](https://github.com/settings/personal-access-tokens/new?name=find_wc-save-worker&description=Cloudflare%20Worker%20that%20saves%20site%20routes%20to%20find_wc%2Fgps_data&target_name=cheongbaek&expires_in=366&contents=write)
(이름·설명·소유자·기한·`Contents: Read and write` 가 채워져 열린다)

1. **Repository access → Only select repositories → `cheongbaek/find_wc`** 하나만 고른다(링크로는 못 채운다).
2. Permissions 는 `Contents: Read and write` 하나(`Metadata: Read-only` 는 저절로 붙는다).
3. **Generate token** → 나온 `github_pat_…` 를 복사한다(이 화면을 벗어나면 다시 못 본다).

> 안드로이드 앱(APK)용 토큰과 **따로** 만든다. 하나가 새도 그것만 지우면 되고 다른 쪽은 산다.

### 2. Cloudflare Worker 만들기 (무료 플랜)

1. <https://dash.cloudflare.com/sign-up> 에서 가입한다.
2. **Workers & Pages → Create application → Create Worker** → 이름 `find-wc-save` → **Deploy**.
3. **Edit code** → 편집기 내용을 모두 지우고 이 폴더의 [`save-worker.js`](save-worker.js) 를 **통째로** 붙여 넣는다 → **Deploy**.
4. Worker 화면의 **Settings → Variables and Secrets → Add** → Type **Secret**, Name **`GITHUB_TOKEN`**,
   Value = 1번의 토큰 → **Deploy**.
5. 확인 : 브라우저로 `https://find-wc-save.<내 서브도메인>.workers.dev/?check=1` 을 연다.
   **"점검 통과"** 가 나오면 끝이다. "점검 실패" 면 그 줄이 이유를 말한다(토큰·리포 선택·권한).

### 3. 사이트에 연결

1. GitHub `find_wc` 리포 → **Settings → Secrets and variables → Actions → Variables** 탭 →
   **New repository variable** → Name **`SAVE_ENDPOINT`**, Value `https://find-wc-save.<내 서브도메인>.workers.dev`
   (비밀값이 아니라 **변수**다 — 주소는 비밀이 아니다).
2. **Actions → Deploy to GitHub Pages → Run workflow** (main).
3. 사이트에서 궤적 생성 → 지정 완료 → 내려받기 아이콘 → **GitHub 에 저장** → 토큰 칸 없이 **저장** 이 되면 끝.

## 서버가 막는 것

누구나 부를 수 있는 주소라서 받는 것을 좁게 거른다.

| 막는 것 | 어떻게 |
|---|---|
| 다른 사이트에서 부르기 | `Origin` 이 `ALLOWED_ORIGINS`(cheongbaek.github.io · 개발 서버) 일 때만 |
| 경로 밖으로 쓰기 | 이름은 영숫자·`._-` 로 된 `.csv`, 항상 `gps_data/` 안 |
| 아무 파일이나 올리기 | `latitude,longitude` 머리줄 + **숫자만 있는 줄 두 줄 이상**(위도 ±90·경도 ±180). 글자·HTML 은 못 실린다 |
| 남의 파일 덮어쓰기 | **덮어쓰지 않는다** — 같은 이름이면 `_2`, `_3` … 을 붙인다 |
| 너무 큰 파일 | 1 MB 까지(0.25 m 간격이면 약 4.5 km) |
| 연달아 보내기 | 같은 IP 는 1분에 10번(인스턴스마다 따로 세는 느슨한 한도) |

지우기·덮어쓰기는 GitHub 에서 사람이 한다.

## 운영

- **토큰 만료·교체** : 새 토큰을 만들어 Cloudflare 의 `GITHUB_TOKEN` 값만 바꾸고 Deploy. 사이트는 손댈 것이 없다.
  만료되면 사이트의 저장이 "저장 서버의 GitHub 토큰이 틀렸거나 기한이 지났습니다" 로 실패한다.
- **코드를 고쳤을 때** : `save-worker.js` 를 대시보드 편집기에 다시 붙여 넣고 Deploy.
- **무료 한도** : 하루 10만 요청, 요청당 CPU 10 ms(GitHub 응답을 기다리는 시간은 안 센다).
  CSV 검사를 정규식 한 번으로 해서 1 MB 가 약 5 ms 다(Node 실측). 1 MB 상한은 그 한도에 맞춘 값이다.
- `gps_data/` 만 바뀐 커밋은 사이트를 다시 배포하지 않는다(`deploy-pages.yml` 의 `paths-ignore`).
