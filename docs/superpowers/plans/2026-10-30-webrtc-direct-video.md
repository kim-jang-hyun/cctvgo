# WebRTC 직접 전송 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카메라 영상을 HLS(Cloudflare 경유) 대신 go2rtc WebRTC로 고객 PC에서 시청자 브라우저까지 직접 보낸다. 실패 원인을 기록하고, H.265 카메라는 서브 스트림이나 PC 변환본으로 PC 브라우저에서도 볼 수 있게 한다.

**Architecture:** cctvgo-service가 `go2rtc.exe`를 자식 프로세스로 띄운다. go2rtc 설정은 시작할 때마다 `cctv.txt`로 새로 만든다. 카메라 추가·삭제는 go2rtc API로 반영한다. 브라우저는 server.js의 인증된 `/api/live/:k/offer`로 SDP를 보내고, server.js는 `127.0.0.1`의 go2rtc `/api/webrtc`로만 전달한다. 영상은 go2rtc WebRTC 포트(UDP/TCP 8555)로 직접 간다. go2rtc 스트림 이름은 카메라 번호 k 기준으로 `s{k}`(원본), `s{k}_sub`(서브), `s{k}_h264`(PC 변환본)를 쓴다.

**Tech Stack:** Node 18 (pkg 번들), Express 4, node:test, Vue 3 + Vite, go2rtc 1.9.x (MIT), 번들 FFmpeg(LGPL, libx264 없음), Windows batch / PowerShell

**Spec:** `docs/superpowers/specs/2026-10-30-webrtc-direct-video-design.md` (시험 기록: `docs/superpowers/spikes/2026-10-30-media-server-spike.md`)

## Global Constraints

- 영상 데이터는 Cloudflare를 거치지 않는다. 연결 실패 시 Cloudflare로 대신 보내는 경로도 만들지 않는다. TURN 없음, UPnP로 포트를 열지 않음(조회만 함).
- 운영자 반복 비용 금지: 로그 수집 서버, 유료 API 없음. 무료 공용 STUN만 쓴다: `stun:stun.l.google.com:19302`.
- go2rtc API/HTTP는 `127.0.0.1`에만 연다. `api.username`/`api.password`는 시작할 때마다 랜덤으로 만들고 **`local_auth: true`**를 켠다(이게 없으면 localhost 요청은 인증 없이 통과한다. 시험으로 확인). go2rtc 내부 RTSP도 `127.0.0.1`에만 연다. 외부에 열리는 것은 WebRTC 포트 하나뿐이다.
- server.js는 go2rtc의 `/api/webrtc`만 호출한다. 그 밖의 go2rtc API를 브라우저 요청으로 전달하는 경로를 만들지 않는다.
- 카메라를 추가·수정·삭제할 때 다른 카메라 영상을 끊지 않는다. stream 번호 k는 주소 기준으로 배정하고 재사용하지 않는다(기존 StreamManager 규칙).
- 인증 실패 예산(`AuthBudget`, IP별 2회)을 완화하지 않는다.
- 카메라 비밀번호를 로그, 진단 정보, 화면에 남기지 않는다. 시청자 IP는 앞 두 자리만 남긴다(`211.36.x.x`).
- `cctv.txt`가 카메라 목록의 유일한 기준이다. 기존 형식(`URL, 이름`)은 그대로 읽힌다. go2rtc 설정 파일은 언제 지워져도 되는 파일이다.
- libx264(GPL)를 넣지 않는다. 변환은 번들 FFmpeg의 `h264_qsv`/`h264_nvenc`/`h264_amf`/`h264_mf`만 쓴다.
- 코드 주석, 테스트 이름, 사용자 문구는 기존처럼 한국어로 쓴다. `make_package.bat`의 새 주석은 ASCII로 쓴다.
- 테스트는 `node --test`(`backend/tests/*.test.js`)를 쓴다. 테스트에서 실제 go2rtc나 FFmpeg를 실행하지 않는다. 프로세스와 HTTP는 주입하거나 가짜 서버로 대신한다.
- 같은 PC에 다른 설치 폴더의 CCTVGO가 있을 수 있다. 시작할 때 프로세스 정리는 이 설치 폴더의 `go2rtc.exe`만 대상으로 한다. (`cctvgo.bat`의 `taskkill /IM`은 기존 방식대로 둔다.)

## Review Focus

1. 카메라 3대 중 2번을 삭제하고 새 카메라를 추가하면, 1·3번 영상이 끊기지 않고 새 카메라는 k=4를 받아야 한다(Task 3 테스트).
2. H.265 카메라를 PC 크롬(H.265 미지원)으로 보면 `s{k}` → 500(codecs not matched) → `s{k}_sub` → `s{k}_h264` 순서로 시도하고, 서브가 H.265면 변환본에서 성공해야 한다. 아이폰(H.265 지원)은 원본에서 바로 성공해야 한다(Task 4 테스트).
3. 로그인하지 않은 요청, 또는 `src`에 `exec:`·다른 이름을 끼워 넣은 요청(`/api/live/1%26src=x/offer`, `k=abc`)은 go2rtc에 닿지 않아야 한다(Task 4 테스트).
4. 서브 주소가 있는 카메라의 아이디·비밀번호를 수정하면 서브 주소의 계정도 함께 바뀌어야 하고, 이름만 바꾸면 서브 주소가 지워지면 안 된다(Task 2, Task 7 테스트).
5. go2rtc가 죽으면 서비스가 다시 띄우고 모든 스트림이 돌아와야 한다. 다시 띄우는 동안 카메라 추가가 들어와도 번호가 꼬이면 안 된다(Task 1, Task 3 테스트).

---

### Task 1: go2rtc 설정 생성과 프로세스 관리

**Files:**
- Create: `go2rtc/go2rtc.exe` (스크래치패드 시험본 v1.9.15를 복사. `.gitignore`에 예외 없음 = 추적됨)
- Create: `backend/streams/go2rtc-config.js`, `backend/streams/go2rtc-process.js`, `backend/streams/go2rtc-api.js`
- Delete: `backend/streams/processes.js`의 영상 전용 함수(`isOurStreamProcess`, `matchesStream`, `spawnStream`). `listProcesses`, `killTree`는 go2rtc 정리용으로 남긴다.
- Test: `backend/tests/go2rtc-config.test.js`, `backend/tests/go2rtc-process.test.js`, `backend/tests/go2rtc-api.test.js`

**Interfaces:**
- Produces:
  - `buildConfig({ apiPort, rtspPort, webrtcPort, username, password, streams }) -> string`. YAML 문자열을 만든다. `streams`는 `{ [name]: src }` 형태다.
  - 상수 `DEFAULT_PORTS = { api: 1984, rtsp: 8554, webrtc: 8555 }`
  - `streamNames(k) -> { main: 's'+k, sub: 's'+k+'_sub', h264: 's'+k+'_h264' }`
  - `class Go2rtcApi({ port, username, password, fetchImpl = fetch })`
    - `putStream(name, src) -> Promise<void>`: `PUT /api/streams?name=&src=`
    - `deleteStream(name) -> Promise<void>`: `DELETE /api/streams?src=name`
    - `offer(name, sdp) -> Promise<{ ok: boolean, status: number, body: string }>`: `POST /api/webrtc?src=name`, `Content-Type: application/sdp`
    - `ping() -> Promise<boolean>`: `GET /api` 등
  - `class Go2rtcProcess({ installDir, logDir, configPath, spawnImpl, procs, log, error, onRestart })`
    - `start(configText) -> Promise<void>`: 이 폴더 `go2rtc\go2rtc.exe`의 남은 프로세스를 정리하고, 설정을 쓰고, 실행한다.
    - 비정상 종료 시 1초 → 2초 → … → 최대 30초로 늦추며 다시 띄우고, 다시 뜨면 `onRestart()`를 호출한다.
    - `stop()`
    - `exe` 경로 getter: 패키지는 `<installDir>\go2rtc\go2rtc.exe`, 개발은 `<repo>\go2rtc\go2rtc.exe`
    - 이벤트 기록은 Task 6의 `diag.event`로 보낸다(주입, 없으면 무시).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `buildConfig`: 결과 YAML에 다음이 들어간다.
    - `listen: "127.0.0.1:1984"`, `local_auth: true`, `username`/`password`
    - `rtsp` `listen: "127.0.0.1:8554"`
    - `webrtc` `listen: ":8555"`, `candidates: [stun:8555]`, `ice_servers`에 `stun:stun.l.google.com:19302`
    - `streams`의 각 항목
    - 비밀번호에 `%21`, `$`, `#`, `"`가 있는 src도 YAML 문자열로 안전하게 들어간다(따옴표 이스케이프). `JSON.stringify`로 값을 감싸는 방식이면 충분하다.
  - `streamNames(12)` → `{ main: 's12', sub: 's12_sub', h264: 's12_h264' }`
  - `Go2rtcApi`: 가짜 HTTP 서버(`http.createServer`)로 확인한다.
    - 모든 요청에 `Authorization: Basic`이 붙는다.
    - `offer`는 201이면 `ok:true`와 본문을 돌려주고, 500·404면 `ok:false`와 status, 본문을 돌려준다.
    - 연결 거부는 `ok:false, status:0`을 돌려준다(예외를 던지지 않음).
  - `Go2rtcProcess`: 가짜 `spawnImpl`과 `procs`로 확인한다.
    - 시작할 때 명령줄에 이 폴더의 `go2rtc\go2rtc.exe`가 있는 프로세스만 `killTree`한다(다른 폴더 것은 남김).
    - 자식이 종료되면 지연 후 다시 spawn하고 `onRestart`를 호출한다.
    - `stop()` 뒤에는 다시 띄우지 않는다.
- [ ] **Step 2: 실행해서 실패 확인** — `cd backend && node --test tests/go2rtc-*.test.js` → 모듈 없음으로 FAIL
- [ ] **Step 3: 구현**
  - 자식 프로세스는 `spawn(exe, ['-c', configPath], { windowsHide: true, stdio: ['ignore', logFd, logFd] })`로 띄운다. 로그는 `logs\go2rtc.log`.
  - 설정 파일 위치: `<installDir>\go2rtc\go2rtc.yaml`. 비밀번호가 들어 있으므로 저장소에서는 `.gitignore`(`/go2rtc/go2rtc.yaml`)에 넣는다.
  - 테스트에서 지연 시간을 줄일 수 있게 지연 함수를 주입받는다.
- [ ] **Step 4: 실행해서 통과 확인** — 같은 명령 → PASS
- [ ] **Step 5: 커밋** — `git add go2rtc/go2rtc.exe .gitignore backend/streams backend/tests && git commit -m "go2rtc 설정 생성, 프로세스 관리, API 클라이언트"`

### Task 2: cctv.txt 서브 주소 형식

**Files:**
- Modify: `backend/finder/cctv-file.js`
- Test: `backend/tests/cctv-file.test.js`

**Interfaces:**
- Produces:
  - `parseCameras(text)`의 각 항목에 `subUrl: string|null`을 더한다.
  - 줄 형식은 `URL, 이름[, 서브URL]`이다. 이름에는 쉼표가 들어갈 수 없다(`sanitizeName`). 그래서 세 번째 필드는 `rtsp://`로 시작할 때만 서브 주소로 본다.
  - `applyEdit`/`saveCameras`의 `append`와 `update`가 `subUrl`(선택)을 받는다. update에서 `subUrl`이 `undefined`이면 기존 서브 주소를 유지하고, `null`이면 지운다.
  - `withCredentials(url, { username, password }) -> string`: 호스트·포트·경로는 그대로 두고 계정만 바꾼다(`parseRtspUrl` + `buildRtspUrl`).

- [ ] **Step 1: 실패하는 테스트 작성**
  - 기존 형식 `rtsp://a:b@192.168.0.2:554/x, 거실`은 `subUrl:null`이 된다.
  - `rtsp://…/101, 거실, rtsp://…/102`는 `subUrl`이 서브 주소다.
  - `rtsp://…/x, 거실, 메모`처럼 세 번째 필드가 rtsp가 아니면 지금처럼 이름이 `거실, 메모`다(기존 동작 유지).
  - append에 subUrl을 주면 세 번째 필드로 써진다.
  - update에서 이름만 바꾸면 서브 주소가 유지된다. `subUrl:null`을 주면 지워진다.
  - `withCredentials('rtsp://old:p%21@192.168.0.5:554/onvif2', { username:'new', password:'a#b' })` → `rtsp://new:a%23b@192.168.0.5:554/onvif2`
- [ ] **Step 2: FAIL 확인** — `node --test tests/cctv-file.test.js`
- [ ] **Step 3: 구현** — 위 Interfaces 대로
- [ ] **Step 4: PASS 확인**
- [ ] **Step 5: 커밋** — `"cctv.txt 에 서브 스트림 주소 저장"`

### Task 3: StreamManager를 go2rtc 스트림 관리로 교체

**Files:**
- Modify: `backend/streams/stream-manager.js`
- Test: `backend/tests/stream-manager.test.js` (FFmpeg 프로세스 가짜를 go2rtc API 가짜로 바꿔 다시 쓴다), `backend/tests/processes.test.js`(남은 함수만)

**Interfaces:**
- Consumes: `Go2rtcApi`(putStream/deleteStream), `streamNames(k)` (Task 1), `parseCameras().subUrl` (Task 2), `transcodeSource(url)` (Task 9. 그 전까지는 `null`을 돌려주는 기본값을 주입)
- Produces: `new StreamManager({ api, transcodeSource = () => null, log, error })`
  - `initialStreams(cameras: [{url, subUrl}]) -> { [name]: src }`: 1..N 번호를 배정하고 go2rtc 시작 설정용 스트림 표를 돌려준다. 서비스 시작 시 Task 1의 `buildConfig`에 넘긴다.
  - `add(url, subUrl?) -> Promise<k>`
  - `restart(oldUrl, newUrl, newSubUrl?) -> Promise<void>`: 같은 k를 유지하고 그 카메라의 세 이름만 다시 PUT한다.
  - `remove(url) -> Promise<void>`
  - `resync() -> Promise<void>`: go2rtc 재시작 후 대응표의 모든 스트림을 다시 PUT한다.
  - `streamIds(urls) -> (number|null)[]`: 기존 `streamUrls`를 대체한다. 같은 주소가 여러 줄이면 앞에서부터 짝짓는다.
  - `variantsOf(k) -> string[]`: 그 카메라에 정의된 이름을 시도 순서대로 돌려준다(`main`, 서브가 있으면 `sub`, 변환원이 있으면 `h264`). Task 4가 쓴다.
- 모든 작업은 지금처럼 `_run` 큐로 한 줄로 실행한다. 대응표를 먼저 고치고 API를 호출한다. API가 실패해도 대응표와 `cctv.txt`는 어긋나지 않는다(지금 규칙과 같음).

- [ ] **Step 1: 실패하는 테스트 작성** (가짜 api는 호출 기록과 실패 주입을 지원)
  - `initialStreams([A,B])`는 `s1`, `s2`를 만든다. B에 서브가 있으면 `s2_sub`도 만든다. `transcodeSource`가 문자열을 주면 `s1_h264`도 만든다.
  - `add(C)`는 k=3을 돌려주고 `s3`만 PUT한다. 다른 이름은 건드리지 않는다.
  - `remove(B)` 뒤 `add(D)`는 k=4를 받고, `s1`·`s3`는 삭제·재PUT되지 않는다.
  - `restart(A, A2)`는 k를 유지하고 `s1`(서브·변환본 포함)만 바꾼다.
  - `resync()`는 대응표 전체를 PUT한다. resync가 진행 중일 때 들어온 `add`는 resync가 끝난 뒤 실행된다.
  - `streamIds`: 같은 주소 두 줄을 앞에서부터 짝짓고, 대응표에 없는 주소는 null을 준다.
  - api 실패 시 `add`는 reject하지만 대응표에는 남는다(`streamIds`에 나타남).
- [ ] **Step 2: FAIL 확인** — `node --test tests/stream-manager.test.js`
- [ ] **Step 3: 구현** — `hls` 폴더 정리와 FFmpeg 프로세스 관련 코드를 모두 지운다.
- [ ] **Step 4: PASS 확인**
- [ ] **Step 5: 커밋** — `"영상 관리를 FFmpeg/HLS 에서 go2rtc 스트림으로 교체"`

### Task 4: 시그널링 API와 server.js 연결

**Files:**
- Create: `backend/streams/live-routes.js`
- Modify: `backend/server.js` (`/hls` 정적 제공 삭제. 시작 순서: StreamManager → `initialStreams` → `Go2rtcProcess.start(buildConfig)` → `onRestart`에서 `streams.resync()`), `backend/finder/camera-routes.js` (`/api/get-channel-list`가 `streamIds`를 쓰고, `add`/`restart`에 서브 주소를 넘김)
- Test: `backend/tests/live-routes.test.js`, `backend/tests/camera-routes.test.js`(채널 목록 형식 변경)

**Interfaces:**
- Consumes: `streams.variantsOf(k)` (Task 3), `api.offer(name, sdp)` (Task 1), `diag.connection(event)` (Task 6. 그 전까지는 아무것도 안 하는 함수를 주입)
- Produces:
  - `registerLiveRoutes(app, { authMiddleware, streams, api, diag })`
  - `POST /api/live/:k/offer`
    - 본문: `express.text({ type: 'application/sdp', limit: '32kb' })`
    - 쿼리: `h265=1|0`
    - 응답 200 `{ sdp, variant: 'main'|'sub'|'h264' }`
    - 실패 시 `{ status:'error', reason: 'codec'|'not_found'|'unavailable', message }`
  - `/api/get-channel-list`의 채널은 `{ name, stream: k|null }`다(기존 `url` 대신).
- 규칙:
  - `k`는 `/^\d{1,4}$/`만 허용하고, 그 외는 400이다.
  - go2rtc에 보내는 이름은 `variantsOf(k)`에서만 나온다(요청 값을 이름에 섞지 않는다).
  - `h265=1`이면 `main`만 시도한다.
  - `h265=0`이면 `main` → `sub` → `h264` 순서로 시도하되, 이전 시도가 500이고 본문에 `codecs not matched`가 있을 때만 다음으로 넘어간다. 404·연결 실패는 바로 `unavailable`로 끝낸다.
  - 요청마다 `diag.connection({ stage:'signaling', k, variant, ok, reason, ms, ua, ip })`를 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성** (supertest 없이 기존 테스트처럼 `app.listen(0)` + fetch. 가짜 api와 가짜 streams 사용)
  - 로그인하지 않으면 401 또는 리다이렉트이고, api.offer가 호출되지 않는다.
  - `k=abc`, `k=1%26src=exec:x`는 400이고, api.offer가 호출되지 않는다.
  - h265=1 → `s1`만 호출한다.
  - h265=0, main 500(codecs not matched) → sub 201 → `{variant:'sub'}`
  - 서브 없음 → h264 201 → `{variant:'h264'}`
  - 모두 codecs not matched → `reason:'codec'`
  - main 404 → `reason:'unavailable'`이고, 다음 이름은 시도하지 않는다.
  - 33KB 본문은 413이다.
  - `/api/get-channel-list` → `[{ name, stream: 1 }, …]`
- [ ] **Step 2: FAIL 확인** — `node --test tests/live-routes.test.js tests/camera-routes.test.js`
- [ ] **Step 3: 구현** — server.js의 PORT 8085와 세션 설정은 그대로 둔다.
- [ ] **Step 4: 전체 테스트 PASS 확인** — `cd backend && npm test`
- [ ] **Step 5: 개발 PC 스모크 확인** (실기 카메라 `192.168.219.100`, `.103`이 있을 때)
  - 임시 `backend/cctv.txt`에 두 카메라를 넣고 `node server.js`를 실행한다.
  - 로그인 쿠키로 시험용 offer SDP(시험 기록의 H264 recvonly)를 `POST /api/live/1/offer?h265=0`에 보내면 `variant:'main'`이 나온다.
  - `/api/live/2/offer?h265=0`은 Task 9 전까지 `reason:'codec'`이 나온다(서브도 H.265).
  - 끝나면 `cctv.txt`를 원래대로(빈 파일) 돌려놓는다.
- [ ] **Step 6: 커밋** — `"WebRTC 시그널링 API (로그인 필요, go2rtc 관리 API 는 전달하지 않음)"`

### Task 5: 시청 화면 WebRTC 재생

**Files:**
- Create: `frontend/src/webrtc.js`
- Modify: `frontend/src/views/LiveCctv.vue` (hls.js 제거), `frontend/package.json` (`hls.js` 삭제)
- 검증: `cd frontend && npm run build` 성공, 그리고 실기 확인(Task 10)

**Interfaces:**
- Consumes: `POST /api/live/:k/offer` (Task 4), `POST /api/live/report` (Task 6)
- Produces:
  - `canReceiveH265() -> boolean`: `RTCRtpReceiver.getCapabilities('video').codecs`에 `video/H265`가 있는지
  - `connectStream(video, k, { onState }) -> () => void`: 반환값은 정리 함수다.
  - `onState(state, detail)`: state는 `'connecting'|'playing'|'failed'`, detail은 `{ reason: 'network'|'codec'|'camera'|'signaling' }`

- [ ] **Step 1: `webrtc.js` 구현**
  - `new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })`
  - `addTransceiver('video', {direction:'recvonly'})`, `addTransceiver('audio', {direction:'recvonly'})`
  - ICE 수집이 끝날 때까지 기다린다(최대 2초). go2rtc POST 방식은 trickle이 없다.
  - `fetch('/api/live/'+k+'/offer?h265='+(canReceiveH265()?1:0), { method:'POST', headers:{'Content-Type':'application/sdp'}, body: offer.sdp })`
  - 15초 안에 `connectionState==='connected'`와 첫 프레임이 없으면 `failed/network`로 본다.
  - 서버 응답 `reason:'codec'`이면 `failed/codec`(재시도 안 함), `unavailable`이면 `failed/camera`로 본다.
  - 실패·끊김 후 자동 재연결: 5초 → 10초 → 최대 60초 간격. `codec`은 재시도하지 않는다.
  - video의 `pause`·`stalled`, 트랙 `unmute`가 일어나면 `video.play()`를 다시 호출한다. go2rtc 시험에서 카메라가 재부팅된 뒤 일시정지로 남은 문제 때문이다.
  - 연결 결과(성공/실패, 걸린 시간, `getStats()`에서 얻은 선택된 후보쌍의 local/remote `candidateType`, 수집한 로컬 후보 종류 목록)를 `/api/live/report`로 한 번 보낸다(`navigator.sendBeacon` 또는 fetch keepalive).
- [ ] **Step 2: `LiveCctv.vue` 교체**
  - 칸마다 `connectStream`을 호출하고 정리 함수를 보관한다. 드래그 교체, 모바일 탭 전환, 언마운트 때 정리한다.
  - 상태 표시 오버레이 문구(설계 4.6):
    - `connecting` → "연결 중..."
    - `failed/network` → "이 네트워크 환경에서는 외부 시청이 불가능합니다"
    - `failed/codec` → "이 브라우저에서는 이 카메라 영상(H.265)을 재생할 수 없습니다"
    - `failed/camera` → "카메라가 응답하지 않습니다"
  - 채널 목록의 `stream`이 null이면 지금처럼 빈 칸이다.
- [ ] **Step 3: 빌드 확인** — `cd frontend && npm install && npm run build` → 오류 없음
- [ ] **Step 4: 커밋** — `"시청 화면을 WebRTC 재생으로 교체 (자동 복구, 원인별 안내)"`

### Task 6: 실패·운용 기록과 진단 정보

**Files:**
- Create: `backend/diagnostics/diag.js`, `backend/diagnostics/environment.js`, `backend/diagnostics/stun.js`, `backend/diagnostics/routes.js`
- Modify: `backend/server.js`(연결), `frontend/src/views/SettingsView.vue`("진단 정보 복사" 버튼, 기존 카메라 찾기 진단 표시와 같은 모양)
- Test: `backend/tests/diag.test.js`, `backend/tests/stun.test.js`, `backend/tests/environment.test.js`

**Interfaces:**
- Produces:
  - `createDiag({ logDir, now = Date.now }) -> { connection(evt), event(kind, detail), env(result), summary() -> object, text() -> string }`
    - `connection`: `logs\connections.log`(한 줄 JSON)에 추가한다. 통계는 `logs\connection-stats.json`(결과별·원인별·후보쌍 종류별 누적, 7일 삭제 대상이 아닌 `.json`)에 쌓는다.
    - `event`: go2rtc 재시작, 카메라 끊김·복구, 방화벽 결과, 선택된 변환기를 `logs\cctvgo-events.log`에 남긴다.
  - `maskIp(ip) -> string`: `211.36.147.187` → `211.36.x.x`. IPv6는 앞 두 묶음만 남긴다. 빈 값은 `알 수 없음`.
  - `stunBinding({ server = 'stun.l.google.com', port = 19302, timeoutMs = 3000, socketImpl }) -> Promise<{ ip, port }|null>`: RFC 5389 Binding Request를 보내고 XOR-MAPPED-ADDRESS를 해석한다.
  - `classifyIp(ip) -> 'public'|'private'|'cgnat'|'unknown'`: CGNAT는 `100.64.0.0/10`, 사설은 RFC1918이다.
  - `checkEnvironment({ run, stun, ssdp }) -> Promise<object>`: 아래를 모은다.
    - 방화벽 규칙 유무(`netsh advfirewall firewall show rule name="CCTVGO go2rtc <설치폴더 해시8>"`)
    - 네트워크 프로필(`Get-NetConnectionProfile`)
    - STUN 바깥 주소와 그 분류
    - 기본 게이트웨이
    - UPnP 응답 여부(SSDP M-SEARCH `urn:schemas-upnp-org:device:InternetGatewayDevice:1`, 3초, **조회만**)
  - 라우트:
    - `POST /api/live/report`(인증, 2KB 제한, 필드를 화이트리스트로 골라 `diag.connection`에 넘김)
    - `GET /api/diagnostics`(인증, `{ text }` 반환)
- `text()`에 넣을 것: CCTVGO 버전, 시작 시각, 환경 점검 결과, 선택된 변환기(Task 9), 최근 연결 50건, 누적 통계. 카메라 주소와 비밀번호는 넣지 않는다(카메라는 번호만).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `maskIp`: IPv4, IPv6, 빈 값
  - `classifyIp`: `100.64.0.1` cgnat, `100.128.0.1` public, `192.168.0.1` private, `14.4.84.110` public
  - `stun.js`: 직접 만든 Binding Response 바이트(XOR-MAPPED-ADDRESS, transaction id 일치)를 해석한다. transaction id가 다르면 무시한다. 시간이 지나면 null.
  - `diag`: `connection`이 파일에 한 줄씩 남고, IP는 마스킹되며, 통계가 누적되고 재시작(새 인스턴스) 뒤에도 유지된다. `text()`에 `rtsp://`와 비밀번호 문자열이 없다.
  - report 라우트: 로그인하지 않으면 거절, 알 수 없는 필드는 버린다, 2KB 초과는 413.
- [ ] **Step 2: FAIL 확인** — `node --test tests/diag.test.js tests/stun.test.js tests/environment.test.js`
- [ ] **Step 3: 구현** — 환경 점검은 서비스 시작 후 비동기로 한 번 실행한다(실패해도 서비스에 영향 없음). 이후 6시간마다 다시 한다.
- [ ] **Step 4: PASS 확인, 프론트 빌드 확인**
- [ ] **Step 5: 개발 PC 확인** — `node server.js` 실행 후 `/api/diagnostics`에서 공인 IP 분류 `public`, UPnP `응답 없음`, 네트워크 프로필이 보이는지 확인한다.
- [ ] **Step 6: 커밋** — `"연결 실패와 운용 기록, 진단 정보 복사"`

### Task 7: 카메라 주소 찾기 코덱 확인과 서브 스트림 저장

**Files:**
- Modify:
  - `backend/finder/rtsp-probe.js` (`describe` 결과에 `codec` 추가)
  - `backend/finder/find-stream.js` (후보에 `codec`, `subUrl`, `subCodec`)
  - `backend/finder/paths.js` (`subPathFor`)
  - `backend/finder/camera-routes.js` (POST `/api/cameras`가 `subUrl`을 받음. edit이 서브 주소 계정도 갱신)
  - `frontend/src/views/CameraFinder.vue` (선택한 후보의 `subUrl`을 함께 저장)
- Test: `backend/tests/rtsp-probe.test.js`, `backend/tests/find-stream.test.js`, `backend/tests/paths.test.js`, `backend/tests/camera-routes.test.js`, `backend/tests/helpers/mock-rtsp.js` (`codecs: { '/path': 'H265' }` 옵션 추가. 기본 H264)

**Interfaces:**
- Produces:
  - `parseVideoCodec(sdp) -> 'H264'|'H265'|string|null`: 첫 `m=video` 섹션의 첫 payload `a=rtpmap`. `HEVC`는 `H265`로 정규화한다.
  - `describe()` 결과 `{ …, codec }`
  - `subPathFor(path) -> string|null`. 치환 규칙(처음 맞는 것 하나):
    - `/Streaming/Channels/(\d)01` → `$102`
    - `subtype=0` → `subtype=1`
    - `_main` → `_sub`
    - `/ch(\d+)/main/` → `/ch$1/sub/`
    - `/stream1` → `/stream2`
    - `/onvif1` → `/onvif2`
    - `/profile1` → `/profile2` (`.smp` 포함)
    - `/live/ch00_0` → `/live/ch00_1`
    - `/videoMain` → `/videoSub`
    - `/media/video1` → `/media/video2`
    - `/live1.sdp` → `/live2.sdp`
    - `/unicast/c1/s0/` → `/unicast/c1/s1/`
    - `/s0` → `/s1`
    - `/11` → `/12`
  - find 결과 후보: `{ url, source, label, codec, subUrl?, subCodec? }`
- 규칙(설계 4.8):
  - ONVIF로 찾은 경우: 검증된 후보 중 H.264가 있으면 그것을 첫 후보로 올린다.
  - 첫 후보가 H.265이면 나머지 검증 후보 중 하나(H.264 우선)를 `subUrl`로 붙인다.
  - 경로 탐색으로 찾은 경우: 찾은 경로가 H.265이고 `subPathFor`가 있으면 `attempt()`로 **한 번만** 확인한다(예산 규칙은 attempt가 그대로 적용). 성공하면 `subUrl`을 붙인다.
  - 사용자 선택 화면의 후보 수는 늘리지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `parseVideoCodec`: H264 SDP, H265 SDP, HEVC 표기, 오디오만 있는 SDP(null)
  - `subPathFor`: 위 규칙 각각 하나 이상, 해당 없음 → null
  - mock 카메라 `/onvif1`(H265), `/onvif2`(H265) → 후보 `{codec:'H265', subUrl:…/onvif2, subCodec:'H265'}`. 인증 실패 기록 0회.
  - `/Streaming/Channels/101`(H265), `/102`(H264) → `subCodec:'H264'`
  - 서브 경로가 404 → `subUrl` 없음. 예산 실패 0회.
  - 서브 확인에서 401 → 예산 1회 기록, 결과는 `found`(메인은 유지)
  - POST `/api/cameras`에 다른 IP의 `subUrl` → 400. 같은 IP → 세 번째 필드로 저장되고 `streams.add(url, subUrl)` 호출
  - edit에서 비밀번호 변경 → 서브 주소도 `withCredentials`로 바뀌어 저장되고 `streams.restart(old, new, newSub)` 호출
- [ ] **Step 2: FAIL 확인** — `node --test tests/rtsp-probe.test.js tests/find-stream.test.js tests/paths.test.js tests/camera-routes.test.js`
- [ ] **Step 3: 구현**
- [ ] **Step 4: 전체 테스트 PASS, 프론트 빌드 확인**
- [ ] **Step 5: 실기 확인** — 개발 서버에서 카메라 찾기로 `192.168.219.103`을 탐색하면(계정은 사용자 제공값) 후보가 H265이고 서브가 `/onvif2`로 붙는지 확인한다. 저장은 하지 않는다.
- [ ] **Step 6: 커밋** — `"카메라 찾기: 코덱 확인, H.265 카메라의 서브 스트림 함께 저장"`

### Task 8: 실행·방화벽·패키징 정리

**Files:**
- Create: `utils/ensure_firewall.ps1` (방화벽 규칙 확인·추가. 인자: 설치 폴더, 로그 폴더)
- Modify: `cctvgo.bat`(위 스크립트 호출), `make_package.bat`, `.gitignore`, `backend/package.json`(description)
- Delete: `run_single_stream.bat`
- 검증: 실제 실행(아래 Step)

- [ ] **Step 1: `cctvgo.bat`**
  - 시작 정리에 `taskkill /F /IM go2rtc.exe /T`를 더한다. `cctvgo-ffmpeg.exe` 정리는 남긴다(Task 9 변환 프로세스).
  - **방화벽 단계**(서비스 시작 전)
    - 규칙 이름: `CCTVGO go2rtc <설치 경로 SHA-1 앞 8자리>` (PowerShell로 계산)
    - `netsh advfirewall firewall show rule name="…"`로 확인하고, 없을 때만 `powershell Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name="…" dir=in action=allow program="%~dp0go2rtc\go2rtc.exe" enable=yes profile=any'`를 실행한다.
    - 결과(있음/추가됨/거절·실패)를 `logs\firewall.log`에 남긴다. 실패해도 계속 진행한다.
  - 상태 점검: "FFmpeg Streams" 줄을 "go2rtc 영상 서버" 줄(프로세스 유무, 시작 중 처리 유지)로 바꾼다.
- [ ] **Step 2: `make_package.bat`**
  - 6번(ffmpeg 복사)은 유지한다.
  - 7번(`run_single_stream.bat`)과 8번(`hls` 폴더)을 지운다.
  - `go2rtc\go2rtc.exe` 복사 단계를 넣는다(`go2rtc.yaml`은 복사하지 않음).
  - 새 주석은 ASCII로 쓴다.
- [ ] **Step 3: `.gitignore`** — `/hls` 삭제, `/go2rtc/go2rtc.yaml` 추가
- [ ] **Step 4: 확인**
  - `make_package.bat`은 Cloudflare 터널을 새로 만들므로 **실행하지 않는다.**
  - 대신 개발 폴더에서 `cctvgo.bat` 흐름 가운데 방화벽 단계만 따로 실행할 수 있는 `utils\ensure_firewall.ps1`로 분리하고, 그 스크립트를 실행해 규칙 확인·로그 기록이 되는지 본다. UAC 창은 사용자가 있을 때만 확인한다(Task 10).
  - bat 파일은 cmd로 문법 오류만 확인한다(`cmd /c "call cctvgo.bat"`는 실행되므로 하지 않음).
- [ ] **Step 5: 커밋** — `"실행/패키징을 go2rtc 기준으로 정리, 첫 실행 시 방화벽 규칙 추가"`

### Task 9: PC 브라우저용 H.265 → H.264 변환

**Files:**
- Create: `backend/streams/encoder-probe.js`
- Modify: `backend/server.js`(시작 시 변환기 선택 → `transcodeSource` 주입), `backend/streams/go2rtc-config.js`(exec 사용에 맞춤)
- Test: `backend/tests/encoder-probe.test.js`

**Interfaces:**
- Consumes: StreamManager의 `transcodeSource` 주입 지점 (Task 3), `diag.event` (Task 6)
- Produces:
  - `ENCODERS = ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf']`
  - `probeEncoders({ ffmpegPath, run }) -> Promise<string|null>`: 각 변환기로 `-f lavfi -i testsrc2=size=1280x720:rate=10 -t 1 -c:v ENC [ENC별 옵션] -f null -`를 실행해 종료 코드 0인 첫 번째를 돌려준다. 시간 제한은 각 15초.
  - `buildTranscodeSource({ ffmpegPath, encoder, url }) -> string`: 시험에서 확인한 형태로 `exec:"<ffmpegPath>" -hide_banner -loglevel error -rtsp_transport tcp -i <url> -an -c:v <encoder> <옵션> -b:v 4M -g 20 -bf 0 -rtsp_transport tcp -f rtsp {output}`를 만든다.
    - 옵션: qsv는 `-look_ahead 0`. mf는 `-hw_encoding 0 -rate_control cbr`.
  - H.265 디코딩 하드웨어 가속: `-hwaccel auto`를 붙였을 때 시험 카메라에서 동작하고 CPU가 줄면 넣는다. 아니면 넣지 않고 그 결과를 이 계획의 실기 기록에 남긴다.
- 변환본 `s{k}_h264`는 모든 카메라에 정의한다. go2rtc는 볼 때만 실행하고, Task 4의 순서에서 main·sub가 코덱으로 실패할 때만 쓰인다. 변환기가 없으면(`null`) 정의하지 않는다. 그러면 Task 4가 `codec`으로 끝나 화면에 안내가 나온다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - 가짜 `run`: qsv 실패 → nvenc 실패 → amf 성공이면 `h264_amf`. 전부 실패하면 null. 각 호출의 인자에 `testsrc2`와 해당 변환기가 있다.
  - `buildTranscodeSource`: 경로에 공백이 있는 ffmpeg는 따옴표로 감싼다. url의 `%21`은 그대로 둔다. qsv와 mf 옵션 차이를 확인한다.
- [ ] **Step 2: FAIL 확인** — `node --test tests/encoder-probe.test.js`
- [ ] **Step 3: 구현** — 변환기 선택은 서비스 시작 시 한 번 하고 결과를 `diag.event('encoder', …)`로 남긴다. 선택이 끝나기 전에 시작한 스트림은 선택 후 `resync()`로 변환본을 더한다.
- [ ] **Step 4: PASS 확인**
- [ ] **Step 5: 개발 PC 확인**
  - 이 PC에서 `h264_qsv`가 선택되는지 확인한다.
  - 시험용 offer로 `/api/live/2/offer?h265=0`이 `variant:'h264'`로 성공하는지 확인한다.
  - 환경 변수 `CCTVGO_ENCODERS=h264_mf`(시험용 덮어쓰기, 코드에 남겨도 됨)로 mf 경로도 같은 결과를 내는지 확인한다.
- [ ] **Step 6: 커밋** — `"H.265 카메라를 PC 브라우저용 H.264 로 변환 (하드웨어 → Windows 내장 순)"`

### Task 10: 실기 확인 (사용자와 함께, main 병합 기준)

설계 5절의 목록을 그대로 확인하고, 결과를 `docs/superpowers/spikes/2026-10-30-media-server-spike.md` 끝에 "실기 확인" 절로 기록한다.
- PC 크롬/엣지, 아이폰, 안드로이드 × LAN / 외부 와이파이 / LG U+ LTE
- 카메라 추가·삭제 중 다른 영상 유지
- 카메라 전원 차단·복구 후 자동 재생
- H.265: 아이폰 원본, PC 변환본
- 첫 실행 UAC 한 번, 거절해도 서비스 동작
- 진단 정보 복사 내용
- 영상 경로: 진단 기록의 후보쌍이 host/srflx/prflx(직접)인지
- 에이징(연속 재생)
- 모두 통과하면 main의 HLS 최종 상태에 `hls-v1.1` 태그를 붙이고 병합을 사용자에게 제안한다.
