# 카메라 주소 찾기 (RTSP Finder) 설계

작성일: 2026-09-27 / 브랜치: `feature/rtsp-finder`

## 목적

사용자가 `cctv.txt`를 직접 편집하지 않고, CCTVGO 웹 UI에서 "카메라 주소 찾기"를 눌러 RTSP URL을 자동으로 찾고 `cctv.txt`에 반영할 수 있게 한다. 대상은 구형 CCTV 사용자(ONVIF 미지원 장비 다수)이다.

## 범위

포함:
- 로컬 서브넷 카메라 후보 탐색 + IP 수동 입력
- 아이디/비밀번호로 RTSP 경로 자동 탐색
- 결과 확인 후 `cctv.txt` 저장 (추가/교체, 백업)

제외 (이번 범위 아님):
- 저장 후 스트림 자동 재시작 (저장 후 "cctvgo.bat을 다시 실행하세요" 안내만 표시)
- 기본 비밀번호(1234) 변경 유도
- 녹화, H.265 대응, WebRTC

## 사용자 입력값

| 값 | 필수 | 비고 |
|---|---|---|
| 아이디/비밀번호 | 필수 | 자동으로 알 수 없음 |
| 카메라 IP | 선택 | 스캔으로 후보 표시, 안 잡히면 수동 입력 |
| 포트 | 불필요 | 554 우선, 8554/88 등 시도 |
| 경로 | 불필요 | 이 기능이 찾는 값 |
| 카메라 이름 | 선택 | 저장 시 입력 |

## 아키텍처

신규 모듈 `backend/finder/`, `server.js`에는 라우트 등록만 추가한다 (pkg 번들에 포함되도록 `require`로 로드).

| 파일 | 역할 |
|---|---|
| `scan.js` | 서브넷 계산, 포트 스캔(`net`), ONVIF WS-Discovery(`dgram`, 보조) |
| `rtsp-probe.js` | RTSP DESCRIBE 직접 전송, Basic/Digest 인증, 응답 코드 분류 |
| `paths.js` | 제조사별 경로 후보 목록 (약 40개, 데이터 전용) |
| `cctv-file.js` | `cctv.txt` 파싱/저장, 주석 헤더 보존, 백업, URL 인코딩 |
| `guard.js` | 사설 IP 검증, 동시 스캔 1개 제한, 요청 횟수 제한 |

### 접근 방식 선택 이유

ffprobe는 미포함이며, 후보당 프로세스 실행은 느리고(수 초) 실패 원인 구분이 어렵다. RTSP DESCRIBE를 소켓으로 직접 보내면 응답 코드(200/401/404)로 원인을 정확히 구분하고 후보당 0.1~0.3초에 끝난다. 코덱/썸네일이 필요하면 기존 `cctvgo-ffmpeg.exe`를 성공한 URL 하나에만 사용한다(후속 확장).

## API

모두 기존 `authMiddleware`(세션 로그인)를 적용한다. 새 인증 방식은 만들지 않는다.

- `POST /api/finder/scan` — 서브넷 스캔. 응답: `[{ ip, port, vendor? }]`
- `POST /api/finder/probe` — 입력 `{ ip, port?, username, password }`. 후보 경로를 순차 시도. 응답: `{ status: 'found' | 'auth_failed' | 'path_not_found' | 'unreachable', url?, tried }`
- `POST /api/finder/save` — 입력 `{ url, name, mode: 'append' | 'replace', replaceIndex? }`. 응답: `{ status, restartRequired: true }`

## 보안

- 대상 IP는 사설 대역(10.x, 172.16-31.x, 192.168.x)만 허용. 외부 IP와 호스트명은 거부.
- 스캔은 동시 1개, `probe`/`save`는 분당 횟수 제한.
- 비밀번호는 로그에 기록하지 않는다.
- 스캔 범위는 서버 NIC의 서브넷(최대 /24)으로 한정.

## `cctv.txt` 저장 규칙

- 저장 전 `cctv.txt.bak` 생성.
- `#` 주석과 빈 줄은 그대로 보존, 카메라 줄만 추가/교체.
- 형식: `rtsp://아이디:비밀번호@IP:포트/경로, 이름`
- 아이디/비밀번호는 URL 인코딩 (`#`→`%23`, `$`→`%24`, `!`→`%21` 등, 기존 코드표와 동일).
- 이름의 콤마는 제거/치환(파서가 `,`로 분리하기 때문).

## 프론트엔드

- 신규 뷰 `frontend/src/views/CameraFinder.vue`, 라우트 `/finder`.
- `LiveCctv.vue`에는 진입 버튼만 추가 (기존 로직 변경 없음).
- 흐름: 스캔 → 카메라 선택(또는 IP 수동 입력) → 아이디/비밀번호 → 자동 탐색(진행 표시) → 결과 확인 → 이름 입력 → 저장 → 재시작 안내.
- 실패 안내: 비밀번호 오류 / 경로 못 찾음 / 접속 불가를 구분해서 표시.

## 오류 처리

- `unreachable`: 포트 닫힘, 타임아웃(연결 1초, DESCRIBE 2초).
- `auth_failed`: 첫 후보에서 401이면 즉시 중단하고 안내(계정 잠금 방지 위해 재시도하지 않음).
- `path_not_found`: 모든 후보가 404 → 수동 입력 안내.
- `save` 실패 시 원본 유지(임시 파일에 쓰고 rename).

## 테스트

- `rtsp-probe`: 로컬 mock RTSP 서버(200/401/404, Basic/Digest)로 단위 테스트.
- `cctv-file`: 주석 보존, 인코딩, append/replace, 백업 검증.
- `guard`: 사설/공인/호스트명 IP 판정.
- 실제 카메라 2대(`192.168.219.100` Hikvision, `.194` onvif)로 수동 검증.

## 열린 항목

없음. 저장 후 자동 재시작은 검증 후 별도 작업으로 다룬다.
