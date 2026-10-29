# 카메라 관리 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 → 카메라 관리 화면에서 카메라를 추가·수정·삭제하고, 재시작 없이 바뀐 카메라의 영상만 켜거나 끄거나 다시 켠다.

**Architecture:** cctv.txt 해석은 `cctv-file.js`의 `parseCameras` 하나로 통일한다. 시작할 때 영상 켜기는 `start_ffmpeg.bat` 대신 서버의 `StreamManager`가 맡는다. StreamManager는 "카메라 줄 순서 → stream 번호" 대응표를 메모리에 두고 `run_single_stream.bat`을 카메라별로 실행하거나 종료한다. 카메라 API(`camera-routes.js`)는 파일 쓰기와 영상 적용을 한 잠금 안에서 처리하고, 수정·삭제 대상은 순번과 줄 해시로 확인한다.

**Tech Stack:** Node 18 (pkg 번들), Express 4, node:test, Vue 3 + vue-router + Vite, Windows batch / PowerShell

**Spec:** `docs/superpowers/specs/2026-10-29-camera-management-design.md`

## Global Constraints

- 어떤 조작도 **다른 카메라 영상을 끊으면 안 된다**(추가·수정·삭제·찾기 모두).
- 인증 실패 예산(`AuthBudget`, IP별 실패 2회 → 30분)을 완화하지 않는다. 수정 시 probe도 같은 budget 인스턴스를 쓴다.
- 비밀번호를 로그·API 응답·화면에 평문으로 남기지 않는다. 단, 기존 probe 응답의 candidate url은 지금처럼 유지한다(사용자가 방금 입력한 값). 서버 로그와 배치 echo에는 주소를 남기지 않는다.
- 사용자가 직접 편집한 cctv.txt의 주석과 줄 순서를 보존한다. 쓰기는 `.bak` 백업 → `.tmp` → rename 방식을 유지한다.
- 모든 API는 `authMiddleware`와 요청 횟수 제한을 적용한다. 사용자에게 보이는 문구는 한국어로 쓴다.
- 코드 주석과 테스트 이름은 기존처럼 한국어로 쓴다. 테스트는 `node --test` 방식(`backend/tests/*.test.js`)을 따른다.
- 테스트에서 실제 프로세스를 실행하거나 종료하지 않는다. 프로세스 함수는 모두 주입한다.
- 개발 PC에서 패키지판 CCTVGO가 돌고 있을 수 있다. 프로세스 정리와 종료는 **이 설치 폴더(scriptDir)의 프로세스로만** 제한한다.

## Review Focus

1. 개발 서버(`node server.js`)를 시작할 때 같은 PC의 `C:\cctvgo\package` 영상이 꺼지면 안 된다. 명령줄에 scriptDir이 들어 있는 프로세스만 대상으로 한다(Task 2 테스트).
2. `stream1`을 끌 때 `stream10`, `stream11`이 함께 꺼지면 안 된다(Task 2 테스트).
3. BOM, `  # 주석`(앞에 공백), 이름 없는 줄, CRLF/LF가 섞인 cctv.txt에서 목록 API와 시작 시 영상 번호가 일치해야 한다(Task 1 테스트).
4. 두 브라우저가 동시에 수정·삭제하면, 늦게 온 요청은 "목록이 바뀌었습니다"로 거부되고 다른 줄은 바뀌지 않아야 한다(Task 3 테스트).
5. 비밀번호에 `#`, `%`, `@`, `:`, `!`가 있을 때, "기존 비밀번호 유지" 수정과 RTSP 직접 입력을 거쳐도 인코딩이 한 번만 적용되어야 한다(Task 1, Task 3 테스트).

---

### Task 1: cctv-file — 통일된 파서, 줄 해시, 편집 연산

**Files:**
- Modify: `backend/finder/cctv-file.js`
- Test: `backend/tests/cctv-file.test.js` (replace 관련 기존 테스트는 새 연산 테스트로 바꾼다)

**Interfaces:**
- Produces:
  - `parseCameras(text) -> Array<{ index, url, name, raw, hash }>`: 첫 줄의 BOM(`\uFEFF`)을 제거하고 `line.trim()`으로 빈 줄과 `#` 주석을 판단한다. `name`이 비어 있으면 `''`를 그대로 둔다(표시용 기본값은 호출 측에서 `카메라 N`으로 정함). `hash` = `raw.trim()`의 sha256 hex 앞 16자.
  - `parseRtspUrl(url) -> { host, port, path, username, password } | null`: `rtsp://[user[:pass]@]host[:port][/path[?query]]`를 정규식으로 분해한다. user와 pass는 `decodeURIComponent`로 풀고, port가 없으면 554, path는 `/`로 시작한다(query 포함). 해석할 수 없으면 null.
  - `sameStream(urlA, urlB) -> boolean`: host, port, path(대소문자 구분)를 비교하고 계정은 무시한다.
  - `applyEdit(text, op) -> { text, index }`, op 형식은 다음 셋 중 하나다.
    - `{ type: 'append', url, name }`: `sameStream`이 같은 줄이 있으면 `code='DUPLICATE'` 오류를 낸다.
    - `{ type: 'update', index, hash, url?, name? }`: url이 없으면 기존 url을 유지하고, name이 없으면 기존 name을 유지한다.
    - `{ type: 'remove', index, hash }`
    - `index` 범위를 벗어나거나 `hash`가 다르면 `code='CONFLICT'` 오류를 낸다.
    - EOL 처리, `sanitizeName`, 주석 보존은 지금 `applyCameraLine`과 같다.
  - `saveCameras(filePath, op) -> { index, backup }`: 파일이 없으면 `''`로 본다. 백업, tmp, rename은 지금 `saveCameraLine`과 같다.
  - `encodeCred`, `buildRtspUrl`는 그대로 export한다. `applyCameraLine`과 `saveCameraLine`은 삭제한다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `parseCameras: BOM과 앞 공백 주석을 주석으로 본다`: `'\uFEFF# a\r\n  # b\r\nrtsp://u:p@192.168.0.5:554/x, 거실\nrtsp://u:p@192.168.0.6:554/y'` → 길이 2, `[0].name==='거실'`, `[1].name===''`, `[1].index===1`
  - `parseCameras: hash 는 같은 줄이면 같고 다르면 다르며 비밀번호가 드러나지 않는다`: 결과의 hash가 16자리 hex이고 `'p'`나 url 문자열을 포함하지 않는다.
  - `parseRtspUrl: 특수문자 비밀번호를 풀어서 돌려준다`: `rtsp://admin:pa%23s%40%3A%21@192.168.0.5/Streaming/Channels/201` → `{ host:'192.168.0.5', port:554, path:'/Streaming/Channels/201', username:'admin', password:'pa#s@:!' }`
  - `parseRtspUrl: 쿼리 포함 경로와 계정 없는 주소`: `rtsp://192.168.0.9:8554/cam/realmonitor?channel=1&subtype=0` → `username:''`, `path:'/cam/realmonitor?channel=1&subtype=0'`. `'http://x'` → null
  - `왕복: buildRtspUrl(parseRtspUrl(u)) 는 인코딩이 한 번만 적용된다`: 위 특수문자 url에 대해 `buildRtspUrl({...parsed, path: parsed.path})`를 다시 `parseRtspUrl`하면 password가 `'pa#s@:!'`
  - `applyEdit append: 같은 host/port/path 는 계정이 달라도 DUPLICATE`
  - `applyEdit update: 이름만 바꾸면 url 은 그대로이고 다른 줄과 주석은 보존된다`
  - `applyEdit update: url 교체는 같은 순번 줄만 바뀐다`
  - `applyEdit remove: 가운데 줄을 지우면 나머지 순서와 주석이 보존된다`
  - `applyEdit update/remove: hash 가 다르거나 index 가 범위 밖이면 CONFLICT 이고 text 는 그대로`(throw 확인)
  - `saveCameras: 파일이 없으면 만들고 백업은 null`, `저장 실패 시 원본 유지`(기존 saveCameraLine 테스트를 옮김)

- [ ] **Step 2: 실행해서 실패 확인**
  Run: `cd backend && node --test tests/cctv-file.test.js`
  Expected: FAIL (`parseRtspUrl is not a function` 등)

- [ ] **Step 3: 위 Interfaces대로 `cctv-file.js` 구현**
  해시는 `crypto.createHash('sha256')`로 만든다. 오류는 `Object.assign(new Error(메시지), { code })` 형태로 낸다. 메시지는 CONFLICT일 때 `'목록이 바뀌었습니다. 화면을 다시 열어 주세요.'`, DUPLICATE일 때 `'이미 등록된 카메라입니다.'`로 한다.

- [ ] **Step 4: 실행해서 통과 확인**
  Run: `cd backend && node --test tests/cctv-file.test.js`
  Expected: PASS. 이 시점에는 routes.test.js가 `saveCameraLine`을 쓰므로 실패해도 된다. Task 3에서 고친다.

- [ ] **Step 5: 커밋** `cctv.txt 파서 통일, 줄 해시와 추가/수정/삭제 연산 추가`

---

### Task 2: StreamManager — 영상 하나씩 켜기/끄기와 번호 대응표

**Files:**
- Create: `backend/streams/stream-manager.js`
- Create: `backend/streams/processes.js`
- Test: `backend/tests/stream-manager.test.js`, `backend/tests/processes.test.js`

**Interfaces:**
- Produces (`processes.js`):
  - `matchesStream(commandLine, k, scriptDir) -> boolean`: 대소문자를 무시하고 scriptDir을 포함하며, 정규식 `(^|[^A-Za-z0-9])stream${k}\.m3u8` 또는 `hls\\stream${k}(["\\\s]|$)`에 맞으면 true.
  - `isOurStreamProcess(commandLine, scriptDir) -> boolean`: scriptDir을 포함하고 `run_single_stream.bat` 또는 `cctvgo-ffmpeg.exe`를 포함하면 true.
  - `listProcesses() -> Promise<Array<{ pid, commandLine }>>`: `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe' or Name='cctvgo-ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`. 결과가 한 개면 배열이 아니라 객체로 오므로 배열로 정규화한다.
  - `killTree(pid) -> Promise<void>`: `taskkill /F /T /PID <pid>`. 실패해도 throw하지 않는다(이미 종료된 경우).
  - `spawnStream({ scriptDir, k, url }) -> void`: `cmd.exe /c run_single_stream.bat "hls\streamK" "streamK.m3u8" 5`를 실행한다. cwd는 scriptDir, env는 `STREAM_URL=url`, `windowsHide: true`. stdout과 stderr는 `scriptDir\logs\stream_K.log`에 append로 연결한다(`fs.openSync(...,'a')`). `hls\streamK`와 `logs` 폴더가 없으면 먼저 만든다.
- Produces (`stream-manager.js`):
  - `class StreamManager({ scriptDir, procs = require('./processes'), log = console.log })`
    - `async startAll(urls: string[])`: `listProcesses` 중 `isOurStreamProcess`인 것을 모두 `killTree`하고, `scriptDir\hls` 폴더를 지운 뒤 다시 만든다. 그다음 `k = 1..N`으로 `spawnStream`을 실행하고 `slots = [1..N]`, `maxUsed = N`으로 둔다.
    - `async add(url) -> k`: `k = ++maxUsed`로 spawn하고 `slots.push(k)`
    - `async restart(index, url)`: `slots[index]`의 k를 stop한 뒤 같은 k로 spawn한다.
    - `async remove(index)`: k를 stop하고 `slots.splice(index, 1)`
    - `async stop(k)`(내부): `listProcesses`에서 `matchesStream(cl, k, scriptDir)`인 것을 모두 `killTree`한다. 루프 cmd(`run_single_stream.bat` 포함)를 먼저, 그다음 ffmpeg 순서로 종료한다.
    - `streamUrl(index) -> string | null`: `/hls/streamK/streamK.m3u8`
    - 로그는 `[STREAM] streamK 시작` / `종료`만 남기고 url은 남기지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** (procs는 가짜 객체로 주입하고, 호출을 기록한다)
  - `matchesStream: stream1 은 stream10/stream11 과 구별된다`: 실제 명령줄 형태 두 가지를 쓴다. 하나는 `C:\cctvgo\package\ffmpeg\bin\cctvgo-ffmpeg.exe ... hls\stream10\stream10.m3u8`, 다른 하나는 `cmd /c "C:\cctvgo\package\run_single_stream.bat "hls\stream1" "stream1.m3u8" "5""`. k=1, scriptDir `C:\cctvgo\package`일 때 앞의 것은 false, 뒤의 것은 true.
  - `matchesStream/isOurStreamProcess: 다른 설치 폴더의 프로세스는 대상이 아니다`: scriptDir이 `C:\cctvgo`일 때 `C:\cctvgo\package\...` 명령줄은 false다. 접두어로만 비교하면 안 되므로 경로 뒤에 `\`를 붙여 비교한다.
  - `startAll: 우리 프로세스만 정리하고 1..N 으로 켠다`: spawn이 k=1,2,3으로 호출되고, `streamUrl(2)==='/hls/stream3/stream3.m3u8'`
  - `remove 후 add: 번호를 재사용하지 않고 다른 카메라 번호는 그대로`: 3대에서 remove(0) → `streamUrl(0)`이 stream2를 가리키고, add → k=4
  - `restart: 같은 번호로 끄고 켜며 다른 번호 프로세스는 건드리지 않는다`: kill 대상 pid가 stream2 프로세스뿐이다.
  - `stop 순서: run_single_stream cmd 를 ffmpeg 보다 먼저 종료한다`
  - `로그에 url 이 남지 않는다`: 주입한 log 함수의 인자에 `'secret'`이 없다.

- [ ] **Step 2: 실행해서 실패 확인**
  Run: `cd backend && node --test tests/stream-manager.test.js tests/processes.test.js` → FAIL (모듈 없음)

- [ ] **Step 3: 위 Interfaces대로 두 파일 구현**

- [ ] **Step 4: 실행해서 통과 확인** → PASS

- [ ] **Step 5: 커밋** `영상을 하나씩 켜고 끄는 StreamManager 추가`

---

### Task 3: 카메라 API (목록·추가·수정·삭제·채널 목록) 와 probe 의 RTSP 주소 입력

**Files:**
- Create: `backend/finder/camera-routes.js`
- Modify: `backend/finder/routes.js` (`/api/finder/cameras`와 `/api/finder/save` 삭제, 공유 상태 분리, probe에 `rtspUrl` 추가)
- Test: `backend/tests/camera-routes.test.js` (생성), `backend/tests/routes.test.js` (옛 cameras/save 테스트 삭제, 검증 케이스는 camera-routes 테스트로 옮김)

**Interfaces:**
- Consumes: Task 1의 `parseCameras`, `parseRtspUrl`, `sameStream`, `saveCameras`, `buildRtspUrl`. Task 2의 `StreamManager` 인터페이스(`add`, `restart`, `remove`, `streamUrl`).
- Produces:
  - `registerFinderRoutes(app, { authMiddleware, baseDir, cctvPath, streams, deps = {}, budget })`: 내부에서 `shared = { budget, probingIps, probeLimiter, doFind, loadSettings }`를 만들고 `registerCameraRoutes(app, { authMiddleware, cctvPath, streams, shared })`를 호출한다. 그래서 server.js는 지금처럼 한 번만 호출하면 된다.
  - `POST /api/finder/probe`: `rtspUrl`(선택)을 받는다. 있으면 `parseRtspUrl`로 ip/port/path/username/password를 채운다. 본문의 username/password가 비어 있지 않으면 그 값이 우선한다. 해석에 실패하면 400 `'RTSP 주소 형식이 올바르지 않습니다.'`. 그다음 검증은 기존과 같고, path가 있으므로 수동 경로 테스트로 동작한다.
  - `GET /api/get-channel-list` → `{ status:'success', channels:[{ name, url }] }`. name이 비어 있으면 `카메라 N`(N = index+1), url = `streams.streamUrl(index)`. 파일이 없으면 빈 배열이다(지금처럼 500을 주지 않음).
  - `GET /api/cameras` → `{ status, cameras:[{ index, hash, name, host, port, path, username }] }`. password는 넣지 않는다.
  - `POST /api/cameras` `{ url, name }`: 지금 save의 url 검증을 그대로 옮긴다(공백/쉼표/금지문자/`@` 중복/사설 IP/rtsp). 그다음 `saveCameras(append)` → `streams.add(url)`. 응답은 `{ status:'success', index, applied }`. DUPLICATE면 409.
  - `POST /api/cameras/:index/edit` `{ hash, name, username, password }`:
    - username이 기존 값과 같고 password가 빈 값이면 → `saveCameras(update, name만)`. 영상은 건드리지 않는다. 응답 `{ status:'saved', applied:true }`
    - 그 밖의 경우: password가 비면 기존 줄의 password를 쓴다. `doFind({ host, port, path: 기존 path, username, password, budget, settings })`. 결과가 `path_not_found`일 때만 path 없이 다시 `doFind`한다.
      - found이고 후보가 1개 → `update(url, name)` 후 `streams.restart(index, url)` → `{ status:'saved', applied }`
      - found이고 후보가 여러 개 → `req.session.pendingEdit = { index, hash, name, urls }`에 저장하고 `{ status:'choose', candidates:[{ label, maskedUrl }], preselect }`를 돌려준다. `preselect`는 기존 path와 같은 후보의 위치이고, 없으면 0.
      - 실패 → probe 결과에서 `candidates`를 뺀 그대로를 돌려준다(status, ambiguous, retryAfterSec, diagnostics…). 프런트가 기존 `messageFor`를 재사용할 수 있게 하기 위해서다.
    - probingIps와 probeLimiter는 probe와 공유한다.
  - `POST /api/cameras/:index/edit/confirm` `{ hash, choice }`: pendingEdit의 index와 hash가 맞아야 한다. 맞으면 `update`와 `restart`를 실행하고 pendingEdit을 지운다. 없거나 맞지 않으면 409.
  - `DELETE /api/cameras/:index` `{ hash }` → `saveCameras(remove)` → `streams.remove(index)` → `{ status:'success', applied }`
  - 쓰기 계열(추가/수정 저장/confirm/삭제)은 한 `createLock()` 안에서 "파일 쓰기 → 영상 적용"을 처리한다. 잠금을 못 얻으면 409 `'다른 변경을 처리 중입니다. 잠시 후 다시 시도하세요.'`. CONFLICT는 409, 그 밖의 파일 쓰기 실패는 500이며 이때 영상은 건드리지 않는다. 영상 적용이 throw하면 `applied:false`로 성공 응답한다.
  - 수정 probe(최대 1분)는 잠금 밖에서 하고, 저장 직전에 잠금과 hash를 다시 확인한다.

- [ ] **Step 1: 실패하는 테스트 작성** (기존 routes.test.js의 `startApp` 패턴을 쓴다. `streams`는 호출을 기록하는 가짜 객체, `deps.findStream`도 가짜. 세션이 필요하므로 테스트 앱에 `express-session`을 붙인다)
  - `로그인하지 않으면 /api/cameras 계열과 get-channel-list 가 막힌다`(302)
  - `get-channel-list: 이름 없는 줄은 카메라 N, url 은 streams.streamUrl 값`
  - `get-channel-list: cctv.txt 가 없거나 비어 있으면 빈 배열`
  - `GET /api/cameras: password 와 원래 url 이 응답에 없다`(응답 문자열에 `'secret'`이 없음)
  - `POST /api/cameras: 추가하면 파일 맨 뒤에 붙고 streams.add 가 그 url 로 호출된다`
  - `POST /api/cameras: 같은 host/port/path 는 409 이고 streams.add 는 호출되지 않는다`
  - `POST /api/cameras: 기존 save 의 잘못된 주소 케이스는 400`(routes.test.js 161~215행 케이스를 옮김)
  - `POST /api/cameras: streams.add 가 throw 해도 저장은 되고 applied:false`
  - `edit: 이름만 바꾸면 findStream 과 streams 를 호출하지 않는다`
  - `edit: 비밀번호를 비우면 기존 비밀번호로 findStream 을 호출한다`: 기존 줄 `rtsp://admin:pa%23s@...`일 때 findStream이 받은 password가 `'pa#s'`
  - `edit: 기존 path 로 먼저 1번 시도하고 path_not_found 일 때만 전체 탐색한다`: auth_failed면 findStream 호출이 1번뿐이다.
  - `edit: 성공하면 같은 순번 줄만 바뀌고 streams.restart(index, 새 url)`
  - `edit: 후보가 여러 개면 choose 를 주고 confirm 으로 저장한다`(maskedUrl에 비밀번호가 없음)
  - `edit/delete: hash 가 다르면 409 이고 파일과 streams 는 그대로`
  - `delete: 그 줄만 지우고 streams.remove(index)`
  - `동시 쓰기: 잠금 중이면 409`(streams.add를 지연 Promise로 만들어 두 요청을 겹친다)
  - `probe rtspUrl: 주소의 계정보다 본문 계정이 우선하고, 특수문자 비밀번호는 인코딩이 한 번만 된다`: findStream이 받은 password가 디코딩된 값이다.

- [ ] **Step 2: 실행해서 실패 확인**
  Run: `cd backend && node --test tests/camera-routes.test.js tests/routes.test.js` → FAIL

- [ ] **Step 3: `camera-routes.js` 구현, `routes.js` 정리**

- [ ] **Step 4: 전체 테스트 통과 확인**
  Run: `cd backend && npm test` → 모든 테스트 PASS

- [ ] **Step 5: 커밋** `카메라 목록/추가/수정/삭제 API 추가, probe 에 RTSP 주소 입력 지원`

---

### Task 4: 서버 연결과 영상 화면

**Files:**
- Modify: `backend/server.js` (`readCCTVConfig`와 기존 `/api/get-channel-list` 삭제. StreamManager를 만들어 `registerFinderRoutes`에 전달하고, `app.listen` 콜백에서 `startAll` 실행)
- Modify: `frontend/src/views/LiveCctv.vue` (`getCameraList`/`initCameraList`가 `channels[{name,url}]`를 쓰고, url을 직접 계산하지 않음)

**Interfaces:**
- Consumes: Task 2 `StreamManager`, Task 3 `registerFinderRoutes(..., { streams })`, `GET /api/get-channel-list`.
- scriptDir: pkg 환경이면 `BASE_DIR`, 개발 환경이면 `path.join(BASE_DIR, '..')`(배치 파일과 hls가 저장소 루트에 있음). `HLS_STATIC_PATH`는 `path.join(scriptDir, 'hls')`와 같아야 한다.
- 시작할 때: `startAll(parseCameras(파일 내용).map(c => c.url))`. 파일이 없으면 빈 배열로 시작한다. 실패하면 `console.error`만 남기고 서버는 계속 돈다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 확인**
  Run: `cd backend && npm test` → PASS. Run: `cd frontend && npm run build` → 오류 없이 빌드됨.
  `backend/cctv.txt`가 빈 상태에서 `cd backend && node server.js`를 실행한다. 로그에 오류가 없고 `[STREAM]` 시작 로그도 없어야 한다. 확인 후 Ctrl+C로 종료한다. 패키지판이 8085 포트를 쓰고 있으면 이 단계는 건너뛰고 보고한다. 패키지판을 끄지 않는다.
- [ ] **Step 3: 커밋** `시작 시 영상 켜기를 서버로 옮기고 영상 화면이 서버가 준 주소를 쓰게 변경`

---

### Task 5: 프런트 공통 모듈, 카메라 관리 화면, 메뉴

**Files:**
- Create: `frontend/src/api.js`: CameraFinder.vue의 `api()`를 옮긴다(`router` 인자를 받거나 `import router`).
- Create: `frontend/src/finder-messages.js`: `messageFor(result, vendorHint)`, `lockedNotice(sec)`, `maskedUrl(url)`을 CameraFinder.vue에서 옮긴다. `authUnsupported` 안내 중 "cctv.txt에 직접 입력해 주세요"는 "아래 'RTSP 주소 직접 입력'을 사용하세요"로 바꾼다.
- Create: `frontend/src/views/CameraManage.vue`
- Modify: `frontend/src/router/index.js`: `/cameras` → CameraManage, `/cameras/add` → CameraFinder, `/cameras/:index/edit` → CameraEdit(Task 7), `/finder`는 `/cameras/add`로 redirect
- Modify: `frontend/src/views/SettingsView.vue`: 메뉴 이름은 "카메라 관리", 설명은 "카메라를 추가하거나 수정·삭제합니다", 링크는 `/cameras`

**Interfaces:**
- Consumes: `GET /api/cameras`, `DELETE /api/cameras/:index`.
- CameraManage 화면 구성(시안 B):
  - 머리글은 `← 설정으로` + "카메라 관리"다.
  - 행마다 이름(비어 있으면 `카메라 N`)과 `host`(port가 554가 아니면 `host:port`), [수정] [삭제]를 둔다.
  - 맨 아래에 [+ 카메라 추가] 버튼을 두고 `/cameras/add`로 이동한다.
  - [수정]은 `/cameras/:index/edit?hash=...`로 이동한다.
  - [삭제]는 `confirm('"이름" 카메라를 삭제할까요?')`로 확인한 뒤 DELETE한다. 성공하면 목록을 다시 불러온다. `applied:false`면 "삭제는 되었지만 영상 적용에 실패했습니다. cctvgo.bat을 다시 실행하세요"를 보여 준다. 409면 메시지를 보여 주고 목록을 다시 불러온다.
- 스타일은 CameraFinder.vue의 scoped 스타일 규칙(`height:100dvh; overflow-y:auto`, 입력 칸 16px)을 따른다.

- [ ] **Step 1: 구현** (CameraEdit 라우트는 Task 7 전까지 빈 컴포넌트로 둬도 된다)
- [ ] **Step 2: 확인** Run: `cd frontend && npm run build` → 성공
- [ ] **Step 3: 커밋** `설정에 카메라 관리 화면 추가`

---

### Task 6: 카메라 추가 화면 (찾기 결과 [추가], RTSP 주소 직접 입력)

**Files:**
- Modify: `frontend/src/views/CameraFinder.vue`

**Interfaces:**
- Consumes: Task 5의 `api`, `messageFor`, `maskedUrl`. `POST /api/finder/scan`, `POST /api/finder/probe`(`rtspUrl` 포함), `GET /api/cameras`, `POST /api/cameras`.
- 바뀌는 점:
  - 머리글은 `← 카메라 관리`(`/cameras`) + "카메라 추가"다.
  - 화면에 들어오면(`onMounted`) `runScan()`과 `GET /api/cameras`를 함께 실행한다. 스캔 버튼 문구는 "다시 찾기"로 바꾼다.
  - 결과 행: IP, 제조사 태그, 포트를 보여 주고 오른쪽에 [추가] 버튼(primary)을 둔다. 등록된 카메라의 host와 같은 IP면 버튼 대신 "등록됨"(초록 글씨)을 표시한다. 행 전체를 누르는 동작은 없앤다.
  - "IP 주소 직접 입력"은 그대로 둔다.
  - 새 섹션 "RTSP 주소 직접 입력": 칸은 주소(placeholder `rtsp://192.168.0.5:554/Streaming/Channels/201`), 아이디, 비밀번호(type=password), 이름이다. [접속 테스트 후 추가]를 누르면 probe(`rtspUrl`, username, password)를 실행하고, found면 바로 `POST /api/cameras { url: candidates[0].url, name }` → saved 단계로 간다. 실패하면 기존 failed 단계와 메시지를 쓴다.
  - result 단계: "저장 방식" select를 없애고, 버튼 문구를 "추가"로 바꾼다. `POST /api/cameras`를 쓴다.
  - saved 단계: "카메라를 추가했습니다. 잠시 후 영상 화면에 나타납니다." `applied:false`면 "추가는 되었지만 영상 적용에 실패했습니다. cctvgo.bat을 다시 실행하세요." 버튼은 [카메라 관리로] [영상 화면으로]다. 재시작 안내 문구는 삭제한다.
  - 409(중복)는 saveError에 서버 메시지를 그대로 보여 준다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 확인** Run: `cd frontend && npm run build` → 성공
- [ ] **Step 3: 커밋** `카메라 추가 화면: 찾기 결과에 추가 버튼, RTSP 주소 직접 입력`

---

### Task 7: 카메라 수정 화면

**Files:**
- Create: `frontend/src/views/CameraEdit.vue`

**Interfaces:**
- Consumes: `GET /api/cameras`, `POST /api/cameras/:index/edit`, `POST /api/cameras/:index/edit/confirm`, Task 5의 `api`, `messageFor`, `maskedUrl`.
- 흐름:
  - 진입하면 목록을 불러와 `index`와 `hash`가 같은 카메라를 찾는다. 없으면 "목록이 바뀌었습니다" 안내와 [카메라 관리로] 버튼을 보여 준다.
  - 폼: IP는 읽기 전용으로 보여 준다. 이름과 아이디는 미리 채우고, 비밀번호는 빈 칸으로 둔다(안내: "바꾸지 않으려면 비워 두세요").
  - CameraFinder와 같은 notice(실패 2회 → 30분)를 보여 준다.
  - [저장]을 누르면 edit를 호출한다. 응답이 `saved`면 완료 메시지(`applied:false`면 재실행 안내)를 보여 주고, [카메라 관리로] 버튼을 둔다.
  - 응답이 `choose`면 라디오 목록(label + maskedUrl)을 `preselect`가 선택된 상태로 보여 주고, [이 주소로 저장]을 누르면 confirm을 호출한다.
  - 그 밖의 status면 `messageFor` 메시지와 진단 정보를 보여 준다(CameraFinder의 failed 단계 마크업 재사용).
  - 아이디/비밀번호를 건드리지 않고 저장하면 서버가 이름만 바꾼다. 화면에서 따로 구분할 필요는 없다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 확인** Run: `cd frontend && npm run build` → 성공
- [ ] **Step 3: 커밋** `카메라 수정 화면 추가`

---

### Task 8: 배치 파일, 패키지, 빈 cctv.txt

**Files:**
- Modify: `backend/cctv.txt` → 0바이트 빈 파일
- Delete: `start_ffmpeg.bat`
- Modify: `make_package.bat`: start_ffmpeg.bat 복사 단계를 삭제한다(run_single_stream.bat 복사는 유지).
- Modify: `run_single_stream.bat`: `echo RTSP_URL: !RTSP_URL!` → `echo RTSP_URL: (보안을 위해 표시하지 않음)`
- Modify: `cctvgo.bat`

**cctvgo.bat 변경:**
- `[1/3] FFmpeg` 실행 단계를 삭제하고 단계 번호를 `[1/2] Cloudflare`, `[2/2] CCTVGO 메인 서비스(카메라 영상 포함)`로 바꾼다. 시작할 때의 `taskkill /F /IM cctvgo-ffmpeg.exe /T`는 유지한다. 이전 서비스가 띄운 run_single_stream cmd는 `cctvgo-service.exe /T`로 함께 정리된다.
- 루프 앞에 `set "FAST_CHECKS=6"`을 둔다.
- 카메라 수: 다른 줄과 같은 방식의 PowerShell 한 줄로 센다. `@(Get-Content cctv.txt -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }).Count`
- FFmpeg 표시:
  - CAM_COUNT=0 → `등록된 카메라 없음 - 웹 화면 설정에서 추가`
  - FF_COUNT>0 → `정상 작동 중 (FF/CAM개)`
  - FF_COUNT=0이고 FAST_CHECKS>0 → `시작 중...`
  - 그 밖에는 지금처럼 오류로 표시한다.
- Service 표시: CS_COUNT=0이고 FAST_CHECKS>0이면 `시작 중...`, 그 밖에는 지금처럼 표시한다.
- 루프 끝에서 FAST_CHECKS>0이면 1을 빼고 `timeout /t 5`로 기다린다. 0이 되면 지금처럼 60초를 기다린다. 이렇게 하면 처음 약 30초 동안 5초 간격으로 확인한다.
- 문구 `(30초마다 자동 갱신)` → `(60초마다 자동 갱신)`

- [ ] **Step 1: 구현**
- [ ] **Step 2: 정적 확인**
  Run: `git grep -n "start_ffmpeg"` → 문서(`docs/`) 외에는 결과가 없어야 한다.
  Run: `cd backend && npm test` → PASS
  cctvgo.bat은 실행하지 않는다. 실행하면 사용 중인 영상이 모두 꺼진다. 실기 확인은 Task 9에서 사용자가 한다.
- [ ] **Step 3: 커밋** `빈 cctv.txt 기본값, 상태 화면의 0대/시작 중 표시, 배치 로그에서 주소 제거`

---

### Task 9: 실기 확인 (사용자와 함께)

자동화하지 않는다. `make_package.bat`으로 패키지를 만든 뒤 사용자에게 아래 순서로 확인을 요청하고 결과를 기록한다.

- [ ] 빈 cctv.txt로 cctvgo.bat 실행 → 처음 30초는 "시작 중...", 그 뒤 Service는 정상, FFmpeg는 "등록된 카메라 없음"으로 표시되는지
- [ ] 설정 → 카메라 관리 → [+ 카메라 추가] → [추가] → 아이디/비밀번호 → 이름 → 완료 → 재시작 없이 영상 화면에 나오는지
- [ ] 두 번째 카메라를 추가할 때(RTSP 주소 직접 입력으로) 첫 카메라 영상이 끊기지 않는지
- [ ] 첫 카메라 이름 수정 → 영상이 끊기지 않는지. 비밀번호 수정 → 그 카메라만 다시 켜지는지
- [ ] 첫 카메라 삭제 → 두 번째 카메라 영상이 끊기지 않는지
- [ ] `logs\stream_N.log`의 배치 echo 줄과 `service.log`에 비밀번호가 없는지
