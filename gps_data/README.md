# gps_data — 단순 기록

[궤적 비교](https://cheongbaek.github.io/find_wc/) 사이트의 **GitHub 에서 선택 → 단순 기록** 탭이
이 폴더의 CSV 를 띄운다.

| 들어오는 길 | 방법 |
|---|---|
| 사이트에서 저장 | **궤적 생성** 탭 → 지정 완료 → 내려받기 아이콘 → **GitHub 에 저장** (파일 하나 = 커밋 하나) |
| 직접 올리기 | GitHub 웹 *Add file → Upload files*, 또는 `git add gps_data/<이름>.csv` |

- ★**공개 리포다**★ — 여기 올린 좌표는 누구나 볼 수 있다.
- 형식은 사이트가 읽는 CSV 면 무엇이든 된다. 매핑(`latitude`/`longitude`)인지 주행(`fix_lat`/`fix_lon`)인지는
  사이트가 **열 이름으로** 가른다. 목록에는 `.csv` 만 나온다(이 README 는 안 나온다).
- 저장소 전체는 `.gitignore` 가 `*.csv` 를 막지만 **이 폴더만 예외**다(`!gps_data/*.csv`).
- **이 폴더만 바뀐 커밋은 사이트를 다시 배포하지 않는다** — `.github/workflows/deploy-pages.yml` 의
  `paths-ignore`. 사이트는 이 폴더를 실행 중에 GitHub API 로 읽으므로 배포가 필요 없다.
- 차량(gold)의 경로 목록과는 **별개**다. 차가 따라갈 경로로 쓰려면 gold 저장소의
  `gold_ws/src/white1/gps_data/` 로 옮긴다(차량 prompt 는 `route_` 로 시작하는 파일만 띄운다).
