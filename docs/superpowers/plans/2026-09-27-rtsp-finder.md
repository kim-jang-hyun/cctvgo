# 카메라 주소 찾기 (RTSP Finder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CCTVGO 웹 UI에서 "카메라 주소 찾기"를 눌러 RTSP URL을 자동으로 찾고 `cctv.txt`에 저장한다.

**Architecture:** `backend/finder/` 아래에 책임별 모듈(guard, cctv-file, paths, rtsp-probe, scan, onvif, find-stream, routes)을 만들고 `server.js`는 라우트 등록만 추가한다. 탐색은 ONVIF `GetStreamUri`(재검증) → 경로 후보 DESCRIBE 순서이며, 카메라당 인증 실패 예산(2회)으로 계정 잠금 위험을 줄인다. 프론트엔드는 신규 뷰 `/finder`를 추가한다.

**Tech Stack:** Node.js (CommonJS, Express 4, 추가 npm 의존성 없음), 내장 `node:test`, Vue 3 + vue-router (Vite).

**Spec:** `docs/superpowers/specs/2026-09-27-rtsp-finder-design.md`

**Branch:** `feature/rtsp-finder` (이미 생성/전환됨). 모든 커밋은 이 브랜치에 한다.

## Global Constraints

- 백엔드는 CommonJS이며 `pkg`가 `node18-win-x64`로 빌드한다. Node 18에 없는 API/문법을 쓰지 않는다. 모듈은 `server.js`에서 정적 `require`로 도달 가능해야 한다(동적 require 금지).
- 새 npm 의존성 추가 금지 (`net`, `dgram`, `http`, `crypto`, `os`, `fs`만 사용).
- 새 API는 모두 기존 `authMiddleware`(세션 로그인)를 적용한다. 새 인증 방식을 만들지 않는다.
- 대상 IP는 사설 대역(10.x, 172.16-31.x, 192.168.x)의 IPv4만 허용. 호스트명/공인 IP 거부. ONVIF 응답이 알려 주는 주소로 접속하지 않고 항상 요청한 IP를 사용한다.
- 카메라(IP)당 **인증 실패 예산 2회** (ONVIF + RTSP + 수동 입력 합산, 서버 메모리에 30분 보관). 예산 소진 시 인증 요청을 보내지 않는다.
- 타임아웃: 포트 연결 확인 500ms, RTSP DESCRIBE 2초, ONVIF SOAP 3초.
- 비밀번호는 로그와 진단 정보에 기록하지 않는다.
- `cctv.txt`: UTF-8, 주석/빈 줄 보존, 저장 전 `cctv.txt.bak` 백업, 임시 파일 후 rename, 아이디/비밀번호는 URL 인코딩(`! ' ( ) *` 포함), 이름의 콤마는 제거.
- 저장 후 스트림 자동 재시작은 하지 않는다. "cctvgo.bat을 다시 실행하세요" 안내만 표시한다.
- 로그/주석/UI 문구는 한국어, 기존 `server.js` 로그 스타일(`console.log`/`console.error`)을 따른다.
- 커밋 메시지는 한국어 한 줄 + 아래 trailer:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`

## File Structure

| 파일 | 책임 |
|---|---|
| `backend/finder/guard.js` | 사설 IP 판정, `AuthBudget`, `createRateLimiter`, `createLock` |
| `backend/finder/cctv-file.js` | `cctv.txt` 파싱/추가/교체/백업 저장, URL 인코딩 |
| `backend/finder/paths.js` | 내장 경로 후보, 외부 `rtsp-paths.json` 병합, 제조사 힌트 정렬 |
| `backend/finder/rtsp-probe.js` | RTSP DESCRIBE 직접 전송, Basic/Digest 인증 |
| `backend/finder/scan.js` | 서브넷 계산, TCP 포트 스캔, WS-Discovery, 결과 병합 |
| `backend/finder/onvif.js` | ONVIF SOAP (`GetSystemDateAndTime`, `GetCapabilities`, `GetProfiles`, `GetStreamUri`) |
| `backend/finder/find-stream.js` | 탐색 오케스트레이션(예산, 성향 감지, 진단 정보) |
| `backend/finder/routes.js` | `/api/finder/*` Express 라우트, 입력 검증 |
| `backend/server.js` | 라우트 등록 2줄 추가 |
| `backend/tests/*.test.js`, `backend/tests/helpers/*` | 단위 테스트, mock RTSP/ONVIF 서버 |
| `frontend/src/views/CameraFinder.vue` | 찾기 화면 |
| `frontend/src/router/index.js` | `/finder` 라우트 |
| `frontend/src/views/LiveCctv.vue` | 진입 버튼만 추가 |

## 공통 인터페이스 요약 (Task 간 계약)

```js
// guard.js
isPrivateIPv4(ip: string): boolean
class AuthBudget { constructor({max=2, lockMs=1800000, now=Date.now}={})
  failures(ip): number; remaining(ip): number; isExhausted(ip): boolean
  retryAfterMs(ip): number; recordFailure(ip): number /*remaining*/; reset(ip): void }
createRateLimiter({max, windowMs, now?}): { allow(key: string): boolean }
createLock(): { tryAcquire(): boolean, release(): void }

// cctv-file.js
encodeCred(value: string): string
buildRtspUrl({username, password, host, port, path}): string
parseCameras(text: string): Array<{index:number, url:string, name:string}>
applyCameraLine(text, {url, name, mode:'append'|'replace', replaceIndex?}): {text:string, index:number}
saveCameraLine(filePath, opts): {index:number, backup:string|null}

// paths.js
loadSettings(baseDir): {paths: Array<{path:string, vendors:string[]}>, onvifPorts:number[], onvifServicePaths:string[]}
orderedPaths(settings, vendorHint?): string[]

// rtsp-probe.js
describe({host, port, path, username?, password?, timeoutMs?}):
  Promise<{status:'ok'|'unauthorized'|'not_found'|'other'|'unreachable', code?:number, authSent:boolean, headers?:object, reason?:string}>

// scan.js
RTSP_PORTS: number[]  // [554, 8554, 88, 10554]
tcpOpen(host, port, timeoutMs?): Promise<boolean>
subnetHosts(address, netmask): string[]
scanNetwork(opts?): Promise<Array<{ip, ports:number[], vendor:string|null, model:string|null, onvif:boolean}>>

// onvif.js
getStreamUris({host, username, password, ports, servicePaths, timeoutMs?}):
  Promise<{status:'ok', uris:Array<{token,name,uri}>} | {status:'auth_failed'} | {status:'unsupported'}>

// find-stream.js
findStream({host, port?, path?, username?, password?, vendorHint?, budget, settings, rtspPorts?, rtspTimeoutMs?, onvifTimeoutMs?}):
  Promise<{status:'found'|'auth_failed'|'auth_locked'|'path_not_found'|'unreachable',
           candidates:Array<{url,source:'onvif'|'path'|'manual',label}>, tried:Array, diagnostics:string,
           ambiguous?:boolean, retryAfterSec?:number}>

// routes.js
registerFinderRoutes(app, {authMiddleware, baseDir, cctvPath, deps?, budget?}): void
```

---

### Task 1: 테스트 인프라 + guard 모듈

**Files:**
- Modify: `backend/package.json` (scripts)
- Create: `backend/finder/guard.js`
- Test: `backend/tests/guard.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: `isPrivateIPv4`, `AuthBudget`, `createRateLimiter`, `createLock` (위 계약)

- [ ] **Step 1: 테스트 스크립트 추가**

`backend/package.json`의 `scripts`에 `test`를 추가한다.

```json
  "scripts": {
    "build-frontend": "cd ../frontend && npm install && npm run build",
    "start": "node server.js",
    "start:all": "npm run build-frontend && npm start",
    "test": "node --test \"tests/**/*.test.js\""
  },
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/guard.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIPv4, AuthBudget, createRateLimiter, createLock } = require('../finder/guard');

test('isPrivateIPv4: 사설 대역만 허용한다', () => {
    for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.0.10', '192.168.219.194']) {
        assert.equal(isPrivateIPv4(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '169.254.1.1', '192.169.0.1', '0.0.0.0']) {
        assert.equal(isPrivateIPv4(ip), false, ip);
    }
});

test('isPrivateIPv4: 호스트명/이상한 형식은 거부한다', () => {
    for (const v of ['localhost', 'camera.local', '192.168.0', '192.168.0.256', '192.168.0.1.5', '010.0.0.1', '192.168.0.01', ' 192.168.0.1', '', null, undefined, 1234]) {
        assert.equal(isPrivateIPv4(v), false, String(v));
    }
});

test('AuthBudget: 실패를 세고 예산이 소진되면 잠긴다', () => {
    let t = 1000;
    const b = new AuthBudget({ max: 2, lockMs: 60000, now: () => t });
    assert.equal(b.remaining('10.0.0.1'), 2);
    assert.equal(b.isExhausted('10.0.0.1'), false);
    assert.equal(b.recordFailure('10.0.0.1'), 1);
    assert.equal(b.isExhausted('10.0.0.1'), false);
    assert.equal(b.recordFailure('10.0.0.1'), 0);
    assert.equal(b.isExhausted('10.0.0.1'), true);
    assert.equal(b.retryAfterMs('10.0.0.1'), 60000);
    t += 20000;
    assert.equal(b.retryAfterMs('10.0.0.1'), 40000);
    assert.equal(b.remaining('10.0.0.2'), 2, 'IP별로 독립');
});

test('AuthBudget: 대기 시간이 지나면 풀리고 reset이 동작한다', () => {
    let t = 0;
    const b = new AuthBudget({ max: 2, lockMs: 1000, now: () => t });
    b.recordFailure('a'); b.recordFailure('a');
    assert.equal(b.isExhausted('a'), true);
    t = 1000;
    assert.equal(b.isExhausted('a'), false);
    assert.equal(b.remaining('a'), 2);
    b.recordFailure('a');
    b.reset('a');
    assert.equal(b.remaining('a'), 2);
});

test('createRateLimiter: 윈도우 안에서 max회까지만 허용한다', () => {
    let t = 0;
    const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.equal(rl.allow('k'), true);
    assert.equal(rl.allow('k'), true);
    assert.equal(rl.allow('k'), false);
    assert.equal(rl.allow('other'), true);
    t = 1001;
    assert.equal(rl.allow('k'), true);
});

test('createLock: 동시에 하나만 획득한다', () => {
    const lock = createLock();
    assert.equal(lock.tryAcquire(), true);
    assert.equal(lock.tryAcquire(), false);
    lock.release();
    assert.equal(lock.tryAcquire(), true);
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/guard.test.js`
Expected: FAIL (`Cannot find module '../finder/guard'`)

- [ ] **Step 4: 구현**

`backend/finder/guard.js`:

```js
'use strict';

/**
 * 카메라 주소 찾기 안전장치 모음
 * - 사설 IP 판정 (외부 IP 스캔/접속 방지)
 * - IP별 인증 실패 예산 (카메라 계정 잠금 방지)
 * - 요청 횟수 제한, 동시 실행 잠금
 */

const OCTET = '(0|[1-9]\\d{0,2})';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

function ipv4Parts(ip) {
    if (typeof ip !== 'string') return null;
    const m = IPV4_RE.exec(ip);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.some(p => p > 255) ? null : parts;
}

/** 10.x.x.x, 172.16-31.x.x, 192.168.x.x 만 true */
function isPrivateIPv4(ip) {
    const p = ipv4Parts(ip);
    if (!p) return false;
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
}

/** IP별 인증 실패 횟수. 마지막 실패로부터 lockMs가 지나면 초기화된다. */
class AuthBudget {
    constructor({ max = 2, lockMs = 30 * 60 * 1000, now = Date.now } = {}) {
        this.max = max;
        this.lockMs = lockMs;
        this.now = now;
        this.map = new Map();
    }

    _entry(ip) {
        const e = this.map.get(ip);
        if (e && this.now() - e.last >= this.lockMs) {
            this.map.delete(ip);
            return null;
        }
        return e || null;
    }

    failures(ip) {
        const e = this._entry(ip);
        return e ? e.count : 0;
    }

    remaining(ip) {
        return Math.max(0, this.max - this.failures(ip));
    }

    isExhausted(ip) {
        return this.remaining(ip) === 0;
    }

    retryAfterMs(ip) {
        const e = this._entry(ip);
        if (!e || e.count < this.max) return 0;
        return Math.max(0, e.last + this.lockMs - this.now());
    }

    recordFailure(ip) {
        const e = this._entry(ip) || { count: 0, last: 0 };
        e.count += 1;
        e.last = this.now();
        this.map.set(ip, e);
        return this.remaining(ip);
    }

    reset(ip) {
        this.map.delete(ip);
    }
}

/** key별 고정 윈도우 요청 제한 */
function createRateLimiter({ max, windowMs, now = Date.now }) {
    const hits = new Map();
    return {
        allow(key) {
            const t = now();
            const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
            if (recent.length >= max) {
                hits.set(key, recent);
                return false;
            }
            recent.push(t);
            hits.set(key, recent);
            return true;
        },
    };
}

/** 동시에 하나만 실행 */
function createLock() {
    let held = false;
    return {
        tryAcquire() {
            if (held) return false;
            held = true;
            return true;
        },
        release() {
            held = false;
        },
    };
}

module.exports = { isPrivateIPv4, AuthBudget, createRateLimiter, createLock };
```

- [ ] **Step 5: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/guard.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: 커밋**

```bash
cd /c/cctvgo && git add backend/package.json backend/finder/guard.js backend/tests/guard.test.js
git commit -m "카메라 찾기: 안전장치(사설 IP, 인증 실패 예산, 요청 제한) 추가" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: cctv-file 모듈 (cctv.txt 읽기/쓰기)

**Files:**
- Create: `backend/finder/cctv-file.js`
- Modify: `.gitignore` (백업/임시 파일 제외)
- Test: `backend/tests/cctv-file.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: `encodeCred`, `buildRtspUrl`, `parseCameras`, `applyCameraLine`, `saveCameraLine` (계약 참조)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/cctv-file.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeCred, buildRtspUrl, parseCameras, applyCameraLine, saveCameraLine } = require('../finder/cctv-file');

const SAMPLE = [
    '# [CCTV 연결 설정 가이드]',
    '',
    '# ↓ 아래에 카메라 정보를 입력하세요',
    'rtsp://admin:start%244962@192.168.219.100:554/Streaming/Channels/101, 거실',
    'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1, 안방',
].join('\r\n');

test('encodeCred: 기존 코드표와 같은 방식으로 인코딩한다', () => {
    assert.equal(encodeCred('start$4962'), 'start%244962');
    assert.equal(encodeCred('dash1101!'), 'dash1101%21');
    assert.equal(encodeCred('a*b'), 'a%2Ab');
    assert.equal(encodeCred("a'b(c)"), 'a%27b%28c%29');
    assert.equal(encodeCred('p#w@d:/?'), 'p%23w%40d%3A%2F%3F');
    assert.equal(encodeCred('한글'), encodeURIComponent('한글'));
});

test('buildRtspUrl: 인증 정보가 있으면 포함한다', () => {
    assert.equal(
        buildRtspUrl({ username: 'admin', password: 'pass#1', host: '192.168.0.10', port: 554, path: '/stream1' }),
        'rtsp://admin:pass%231@192.168.0.10:554/stream1'
    );
    assert.equal(
        buildRtspUrl({ username: '', password: '', host: '192.168.0.10', port: 8554, path: 'live' }),
        'rtsp://192.168.0.10:8554/live'
    );
});

test('parseCameras: 주석/빈 줄을 제외하고 주소와 이름을 읽는다', () => {
    const cams = parseCameras(SAMPLE);
    assert.equal(cams.length, 2);
    assert.deepEqual(cams[1], { index: 1, url: 'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1', name: '안방' });
});

test('applyCameraLine append: 주석을 보존하고 CRLF로 끝에 추가한다', () => {
    const r = applyCameraLine(SAMPLE, { url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.index, 2);
    assert.ok(r.text.startsWith('# [CCTV 연결 설정 가이드]\r\n\r\n# ↓'));
    assert.ok(r.text.endsWith('안방\r\nrtsp://a:b@192.168.0.5:554/x, 주방\r\n'));
    assert.equal(parseCameras(r.text).length, 3);
});

test('applyCameraLine append: LF 파일은 LF를 유지하고 빈 파일은 CRLF', () => {
    const lf = applyCameraLine('# c\nrtsp://a:b@10.0.0.1:554/x, 1\n', { url: 'rtsp://a:b@10.0.0.2:554/y', name: '2', mode: 'append' });
    assert.equal(lf.text, '# c\nrtsp://a:b@10.0.0.1:554/x, 1\nrtsp://a:b@10.0.0.2:554/y, 2\n');
    const empty = applyCameraLine('', { url: 'rtsp://a:b@10.0.0.2:554/y', name: '2', mode: 'append' });
    assert.equal(empty.text, 'rtsp://a:b@10.0.0.2:554/y, 2\r\n');
});

test('applyCameraLine replace: 지정한 카메라 줄만 교체한다', () => {
    const r = applyCameraLine(SAMPLE, { url: 'rtsp://n:p@192.168.0.9:554/z', name: '새 안방', mode: 'replace', replaceIndex: 1 });
    const cams = parseCameras(r.text);
    assert.equal(cams.length, 2);
    assert.equal(cams[0].name, '거실');
    assert.deepEqual(cams[1], { index: 1, url: 'rtsp://n:p@192.168.0.9:554/z', name: '새 안방' });
    assert.ok(r.text.includes('# [CCTV 연결 설정 가이드]'));
});

test('applyCameraLine replace: 범위를 벗어나면 오류', () => {
    assert.throws(() => applyCameraLine(SAMPLE, { url: 'rtsp://x', name: 'n', mode: 'replace', replaceIndex: 5 }), /교체할 카메라/);
    assert.throws(() => applyCameraLine(SAMPLE, { url: 'rtsp://x', name: 'n', mode: 'replace' }), /교체할 카메라/);
});

test('이름의 콤마/줄바꿈은 제거하고 비어 있으면 기본 이름을 쓴다', () => {
    const a = applyCameraLine('', { url: 'rtsp://a@10.0.0.1:554/x', name: '거실, 큰방\n2', mode: 'append' });
    assert.equal(parseCameras(a.text)[0].name, '거실 큰방 2');
    const b = applyCameraLine('', { url: 'rtsp://a@10.0.0.1:554/x', name: '  ', mode: 'append' });
    assert.equal(parseCameras(b.text)[0].name, '카메라 1');
});

test('saveCameraLine: 백업을 만들고 임시 파일을 남기지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    fs.writeFileSync(file, SAMPLE, 'utf8');
    const r = saveCameraLine(file, { url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.index, 2);
    assert.equal(r.backup, file + '.bak');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), SAMPLE);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 3);
    assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('saveCameraLine: 파일이 없으면 새로 만든다 (백업 없음)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    const r = saveCameraLine(file, { url: 'rtsp://a@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.backup, null);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 1);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/cctv-file.test.js`
Expected: FAIL (`Cannot find module '../finder/cctv-file'`)

- [ ] **Step 3: 구현**

`backend/finder/cctv-file.js`:

```js
'use strict';
const fs = require('fs');

/**
 * cctv.txt 읽기/쓰기.
 * 카메라 줄 형식: rtsp://아이디:비밀번호@IP:포트/경로, 이름
 * - '#' 주석과 빈 줄은 그대로 보존한다.
 * - 아이디/비밀번호는 URL 인코딩한다 (cctv.txt 안내의 특수문자 코드표와 동일: ! -> %21, * -> %2A ...).
 */

function encodeCred(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildRtspUrl({ username, password, host, port, path }) {
    const auth = username ? `${encodeCred(username)}:${encodeCred(password || '')}@` : '';
    const p = path ? (path.startsWith('/') ? path : '/' + path) : '';
    return `rtsp://${auth}${host}:${port}${p}`;
}

function detectEol(text) {
    return text.includes('\n') && !text.includes('\r\n') ? '\n' : '\r\n';
}

function isCameraLine(line) {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
}

function sanitizeName(name, fallback) {
    const clean = String(name || '').replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean || fallback;
}

function parseCameras(text) {
    return text
        .split(/\r?\n/)
        .filter(isCameraLine)
        .map((line, index) => {
            const i = line.indexOf(',');
            const url = (i >= 0 ? line.slice(0, i) : line).trim();
            const name = i >= 0 ? line.slice(i + 1).trim() : '';
            return { index, url, name };
        });
}

/** text에 카메라 줄을 추가/교체한 새 text를 반환한다 (파일 접근 없음) */
function applyCameraLine(text, { url, name, mode = 'append', replaceIndex }) {
    const eol = detectEol(text);
    const cameras = parseCameras(text);

    if (mode === 'replace') {
        if (!Number.isInteger(replaceIndex) || replaceIndex < 0 || replaceIndex >= cameras.length) {
            throw new Error('교체할 카메라를 찾을 수 없습니다.');
        }
        const newLine = `${url}, ${sanitizeName(name, `카메라 ${replaceIndex + 1}`)}`;
        const lines = text.split(/\r?\n/);
        let seen = -1;
        for (let i = 0; i < lines.length; i++) {
            if (isCameraLine(lines[i]) && ++seen === replaceIndex) {
                lines[i] = newLine;
                break;
            }
        }
        return { text: lines.join(eol), index: replaceIndex };
    }

    const newLine = `${url}, ${sanitizeName(name, `카메라 ${cameras.length + 1}`)}`;
    const sep = text.length === 0 || /\n$/.test(text) ? '' : eol;
    return { text: text + sep + newLine + eol, index: cameras.length };
}

/** 백업(.bak) 후 임시 파일에 쓰고 rename 한다. 실패하면 원본은 그대로 남는다. */
function saveCameraLine(filePath, opts) {
    const exists = fs.existsSync(filePath);
    const text = exists ? fs.readFileSync(filePath, 'utf8') : '';
    const result = applyCameraLine(text, opts);

    let backup = null;
    if (exists) {
        backup = filePath + '.bak';
        fs.copyFileSync(filePath, backup);
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, result.text, 'utf8');
    fs.renameSync(tmp, filePath);
    return { index: result.index, backup };
}

module.exports = { encodeCred, buildRtspUrl, parseCameras, applyCameraLine, saveCameraLine };
```

- [ ] **Step 4: .gitignore에 백업/임시 파일 추가**

`.gitignore` 의 `/backend/.env` 줄 아래에 추가:

```
/backend/cctv.txt.bak
/backend/cctv.txt.tmp
```

- [ ] **Step 5: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/cctv-file.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: 커밋**

```bash
cd /c/cctvgo && git add .gitignore backend/finder/cctv-file.js backend/tests/cctv-file.test.js
git commit -m "카메라 찾기: cctv.txt 추가/교체/백업 저장 모듈" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: paths 모듈 (경로 후보 + 외부 rtsp-paths.json)

**Files:**
- Create: `backend/finder/paths.js`
- Test: `backend/tests/paths.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: `loadSettings(baseDir)`, `orderedPaths(settings, vendorHint)`, `BUILT_IN_PATHS` (계약 참조)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/paths.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSettings, orderedPaths, BUILT_IN_PATHS } = require('../finder/paths');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-paths-'));
}

test('내장 후보에 실제 카메라 경로가 들어 있고 80개 이상이다', () => {
    const list = orderedPaths(loadSettings(tmpDir()));
    assert.ok(list.includes('/Streaming/Channels/101'));
    assert.ok(list.includes('/onvif1'));
    assert.ok(list.length >= 80, `후보 수: ${list.length}`);
    assert.equal(new Set(list).size, list.length, '중복 없음');
});

test('외부 rtsp-paths.json이 없으면 내장 값만 쓴다', () => {
    const s = loadSettings(tmpDir());
    assert.equal(s.paths.length, BUILT_IN_PATHS.length);
    assert.deepEqual(s.onvifPorts.slice(0, 3), [80, 8080, 2020]);
    assert.ok(s.onvifServicePaths.includes('/onvif/device_service'));
});

test('외부 파일의 값은 내장 값에 합쳐지고 경로는 맨 앞에 온다', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), JSON.stringify({
        paths: ['/custom/ch1', '/onvif1'],
        onvifPorts: [9999, 80],
        onvifServicePaths: ['/custom/onvif'],
    }));
    const s = loadSettings(dir);
    const list = orderedPaths(s);
    assert.equal(list[0], '/custom/ch1');
    assert.equal(list[1], '/onvif1');
    assert.equal(new Set(list).size, list.length);
    assert.ok(s.onvifPorts.includes(9999));
    assert.equal(s.onvifPorts.filter(p => p === 80).length, 1);
    assert.ok(s.onvifServicePaths.includes('/custom/onvif'));
});

test('외부 파일이 깨져 있거나 형식이 틀리면 무시한다', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), '{ not json');
    assert.equal(loadSettings(dir).paths.length, BUILT_IN_PATHS.length);

    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), JSON.stringify({ paths: [1, null, '', 'nosl', '/ok'], onvifPorts: ['80', 0, 70000, 8081] }));
    const s = loadSettings(dir);
    const list = orderedPaths(s);
    assert.equal(list[0], '/ok');
    assert.ok(!list.includes('nosl') && !list.includes(''));
    assert.ok(s.onvifPorts.includes(8081) && !s.onvifPorts.includes(0) && !s.onvifPorts.includes(70000));
});

test('제조사 힌트가 있으면 해당 제조사 경로가 앞선다', () => {
    const s = loadSettings(tmpDir());
    assert.equal(orderedPaths(s, 'Reolink RLC-510A')[0], '/h264Preview_01_main');
    assert.equal(orderedPaths(s, 'DAHUA')[0], '/cam/realmonitor?channel=1&subtype=0');
    assert.equal(orderedPaths(s, '알 수 없는 제조사')[0], '/Streaming/Channels/101');
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/paths.test.js`
Expected: FAIL (`Cannot find module '../finder/paths'`)

- [ ] **Step 3: 구현**

`backend/finder/paths.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * RTSP 경로 후보.
 * - 앞쪽일수록 흔한 경로다. vendors 는 제조사 힌트(WS-Discovery 이름/모델)와 대소문자 무시 부분일치로 비교한다.
 * - 설치형 제품이라 출시 후 수정이 어렵다. 후보를 추가할 때는 이 목록 또는 설치 폴더의 rtsp-paths.json 을 쓴다.
 */
const RAW = [
    ['/Streaming/Channels/101', ['hikvision', 'hik', 'ezviz']],
    ['/onvif1', []],
    ['/stream1', ['tp-link', 'tapo', 'vstarcam']],
    ['/cam/realmonitor?channel=1&subtype=0', ['dahua', 'amcrest', 'imou', 'lorex']],
    ['/h264Preview_01_main', ['reolink']],
    ['/live/ch00_0', ['xiongmai', 'xm']],
    ['/live/ch0', []],
    ['/live', []],
    ['/stream', []],
    ['/h264', []],
    ['/1', []],
    ['/11', ['foscam']],
    ['/ch01', []],
    ['/Streaming/Channels/102', ['hikvision', 'hik', 'ezviz']],
    ['/Streaming/Channels/1', ['hikvision', 'hik']],
    ['/Streaming/Channels/201', ['hikvision', 'hik']],
    ['/Streaming/Unicast/channels/101', ['hikvision', 'hik']],
    ['/h264/ch1/main/av_stream', ['hikvision', 'hik']],
    ['/h264/ch1/sub/av_stream', ['hikvision', 'hik']],
    ['/cam/realmonitor?channel=1&subtype=1', ['dahua', 'amcrest', 'imou', 'lorex']],
    ['/h264Preview_01_sub', ['reolink']],
    ['/Preview_01_main', ['reolink']],
    ['/stream2', ['tp-link', 'tapo', 'vstarcam']],
    ['/onvif2', []],
    ['/onvif3', []],
    ['/profile1', []],
    ['/profile2', []],
    ['/profile1/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/profile2/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/profile5/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/onvif/profile1/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/onvif/profile2/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/axis-media/media.amp', ['axis']],
    ['/axis-media/media.amp?videocodec=h264', ['axis']],
    ['/mpeg4/media.amp', ['axis']],
    ['/live.sdp', ['vivotek']],
    ['/live1.sdp', ['vivotek']],
    ['/live2.sdp', ['vivotek']],
    ['/videoMain', ['foscam']],
    ['/videoSub', ['foscam']],
    ['/media/video1', ['uniview', 'unv', 'sony']],
    ['/media/video2', ['uniview', 'unv', 'sony']],
    ['/unicast/c1/s0/live', ['uniview', 'unv']],
    ['/unicast/c1/s1/live', ['uniview', 'unv']],
    ['/MediaInput/h264', ['panasonic']],
    ['/MediaInput/mpeg4', ['panasonic']],
    ['/nphMpeg4/g726-640x480', ['panasonic']],
    ['/rtsp_tunnel', ['bosch']],
    ['/s0', ['ubiquiti', 'unifi']],
    ['/s1', ['ubiquiti', 'unifi']],
    ['/CH001.sdp', ['geovision']],
    ['/CH002.sdp', ['geovision']],
    ['/live/main', ['milesight']],
    ['/live/sub', ['milesight']],
    ['/live/0/MAIN', []],
    ['/live/1/SUB', []],
    ['/live/av0', []],
    ['/av0_0', []],
    ['/av1_0', []],
    ['/tcp/av0_0', []],
    ['/udp/av0_0', []],
    ['/cam1/h264', []],
    ['/cam1/mpeg4', []],
    ['/cam1/onvif-h264', []],
    ['/video1', []],
    ['/video.h264', []],
    ['/mpeg4', []],
    ['/mpeg4/1/media.amp', []],
    ['/ch0_0.h264', []],
    ['/ch0_1.h264', []],
    ['/ch1', []],
    ['/ch2', []],
    ['/0', []],
    ['/2', []],
    ['/12', []],
    ['/main', []],
    ['/sub', []],
    ['/stream0', []],
    ['/h264_stream', []],
    ['/live/ch01_0', []],
    ['/live/ch1', []],
    ['/1/h264major', []],
    ['/1/stream1', []],
    ['/ipcam/stream.sdp', []],
    ['/ipcam.sdp', []],
];

const BUILT_IN_PATHS = RAW.map(([p, vendors]) => ({ path: p, vendors }));
const BUILT_IN_ONVIF_PORTS = [80, 8080, 2020, 8000, 8899];
const BUILT_IN_ONVIF_SERVICE_PATHS = ['/onvif/device_service'];

function readExternal(baseDir) {
    const file = path.join(baseDir, 'rtsp-paths.json');
    try {
        if (!fs.existsSync(file)) return {};
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error('rtsp-paths.json 을 읽을 수 없어 내장 후보만 사용합니다:', error.message);
        return {};
    }
}

function unique(list) {
    return Array.from(new Set(list));
}

/** 내장 값과 설치 폴더의 rtsp-paths.json 을 합친 설정 (호출할 때마다 파일을 다시 읽는다) */
function loadSettings(baseDir) {
    const ext = readExternal(baseDir);
    const extPaths = (Array.isArray(ext.paths) ? ext.paths : [])
        .filter(p => typeof p === 'string' && p.startsWith('/'))
        .map(p => ({ path: p, vendors: [] }));
    const extPorts = (Array.isArray(ext.onvifPorts) ? ext.onvifPorts : [])
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 65535);
    const extServicePaths = (Array.isArray(ext.onvifServicePaths) ? ext.onvifServicePaths : [])
        .filter(p => typeof p === 'string' && p.startsWith('/'));

    return {
        paths: [...extPaths, ...BUILT_IN_PATHS],
        onvifPorts: unique([...BUILT_IN_ONVIF_PORTS, ...extPorts]),
        onvifServicePaths: unique([...BUILT_IN_ONVIF_SERVICE_PATHS, ...extServicePaths]),
    };
}

/** 외부 경로가 맨 앞, 그 다음 제조사 힌트와 일치하는 경로, 나머지 순서. 중복 제거. */
function orderedPaths(settings, vendorHint = '') {
    const hint = String(vendorHint || '').toLowerCase();
    const matches = entry => hint !== '' && entry.vendors.some(v => hint.includes(v));
    const external = settings.paths.filter(e => e.vendors.length === 0 && !BUILT_IN_PATHS.some(b => b.path === e.path));
    const rest = settings.paths.filter(e => !external.includes(e));
    return unique([
        ...external.map(e => e.path),
        ...rest.filter(matches).map(e => e.path),
        ...rest.filter(e => !matches(e)).map(e => e.path),
    ]);
}

module.exports = { BUILT_IN_PATHS, loadSettings, orderedPaths };
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/paths.test.js`
Expected: PASS (5 tests). 후보 수 테스트가 실패하면 `RAW`에 경로를 더 추가해 80개 이상으로 맞춘다.

- [ ] **Step 5: 커밋**

```bash
cd /c/cctvgo && git add backend/finder/paths.js backend/tests/paths.test.js
git commit -m "카메라 찾기: RTSP 경로 후보와 외부 rtsp-paths.json 병합" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: rtsp-probe 모듈 + mock RTSP 서버

**Files:**
- Create: `backend/finder/rtsp-probe.js`
- Create: `backend/tests/helpers/mock-rtsp.js`
- Create: `backend/tests/helpers/ports.js`
- Test: `backend/tests/rtsp-probe.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: `describe({host, port, path, username?, password?, timeoutMs?})` (계약 참조), 테스트 헬퍼 `createMockRtsp`, `getClosedPort`

- [ ] **Step 1: 테스트 헬퍼 작성**

`backend/tests/helpers/ports.js`:

```js
'use strict';
const net = require('net');

/** 아무도 듣고 있지 않은 로컬 포트를 하나 얻는다 */
function getClosedPort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

module.exports = { getClosedPort };
```

`backend/tests/helpers/mock-rtsp.js`:

```js
'use strict';
const net = require('net');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

/**
 * 테스트용 가짜 RTSP 카메라 (DESCRIBE만 처리).
 * - scheme: 'digest' | 'basic', qop: Digest qop=auth 사용 여부
 * - validPaths: 200을 돌려줄 경로 (쿼리 포함)
 * - unknownPathStatus: 인증 성공 후 없는 경로에 줄 코드. 404(대부분) 또는 401(일부 카메라)
 * - state.failedAuth: 카메라 입장에서 "로그인 실패"로 셀 수 있는 401 횟수
 */
async function createMockRtsp({
    users = { admin: 'pw' },
    scheme = 'digest',
    qop = false,
    validPaths = ['/stream1'],
    unknownPathStatus = 404,
    requireAuth = true,
    host = '127.0.0.1',
    port = 0,
} = {}) {
    const state = { requests: [], failedAuth: 0 };
    const realm = 'mock';
    const nonce = 'abcdef123456';

    function challengeHeader() {
        if (scheme === 'basic') return `WWW-Authenticate: Basic realm="${realm}"\r\n`;
        return `WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}"${qop ? ', qop="auth"' : ''}\r\n`;
    }

    function checkAuth(header, method, uri) {
        if (/^basic /i.test(header)) {
            const decoded = Buffer.from(header.slice(6), 'base64').toString();
            const i = decoded.indexOf(':');
            const user = decoded.slice(0, i);
            return users[user] !== undefined && users[user] === decoded.slice(i + 1);
        }
        const f = key => {
            const m = new RegExp(`(?:^|[\\s,])${key}="?([^",]*)"?`).exec(header);
            return m ? m[1] : null;
        };
        const user = f('username');
        if (!user || users[user] === undefined || f('nonce') !== nonce) return false;
        const ha1 = md5(`${user}:${realm}:${users[user]}`);
        const ha2 = md5(`${method}:${uri}`);
        const expected = qop
            ? md5(`${ha1}:${nonce}:${f('nc')}:${f('cnonce')}:auth:${ha2}`)
            : md5(`${ha1}:${nonce}:${ha2}`);
        return f('response') === expected;
    }

    const server = net.createServer(socket => {
        let buf = '';
        socket.on('data', d => {
            buf += d.toString('latin1');
            if (!buf.includes('\r\n\r\n')) return;
            const lines = buf.split('\r\n');
            const [method, uri] = lines[0].split(' ');
            const headers = {};
            for (const l of lines.slice(1)) {
                const i = l.indexOf(':');
                if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
            }
            const u = new URL(uri);
            const reqPath = u.pathname + u.search;
            const auth = headers['authorization'];

            let code = 200;
            let extra = '';
            if (requireAuth && !auth) {
                code = 401;
                extra = challengeHeader();
            } else if (requireAuth && !checkAuth(auth, method, uri)) {
                code = 401;
                extra = challengeHeader();
                state.failedAuth++;
            } else if (!validPaths.includes(reqPath)) {
                code = unknownPathStatus;
                if (code === 401) {
                    extra = challengeHeader();
                    state.failedAuth++;
                }
            }
            state.requests.push({ method, path: reqPath, authed: !!auth, code });
            const reason = { 200: 'OK', 401: 'Unauthorized', 404: 'Not Found' }[code] || 'Error';
            const body = code === 200 ? 'v=0\r\n' : '';
            socket.end(`RTSP/1.0 ${code} ${reason}\r\nCSeq: 1\r\nServer: MockCam/1.0\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`);
        });
        socket.on('error', () => {});
    });

    await new Promise(resolve => server.listen(port, host, resolve));
    return {
        port: server.address().port,
        state,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = { createMockRtsp };
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/rtsp-probe.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../finder/rtsp-probe');
const { createMockRtsp } = require('./helpers/mock-rtsp');
const { getClosedPort } = require('./helpers/ports');

const HOST = '127.0.0.1';

test('Digest 인증: 올바른 계정이면 ok', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
        assert.equal(r.code, 200);
        assert.equal(r.authSent, true);
        assert.equal(r.headers.server, 'MockCam/1.0');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('Digest qop=auth 인증도 지원한다', async () => {
    const cam = await createMockRtsp({ qop: true, validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('Basic 인증을 지원한다', async () => {
    const cam = await createMockRtsp({ scheme: 'basic', validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 unauthorized 이고 authSent=true', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'wrong' });
        assert.equal(r.status, 'unauthorized');
        assert.equal(r.authSent, true);
        assert.equal(cam.state.failedAuth, 1);
    } finally { await cam.close(); }
});

test('경로가 없으면 not_found (계정은 맞음)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/nope', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'not_found');
        assert.equal(r.authSent, true);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('인증이 필요 없는 카메라는 계정 없이 ok', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1' });
        assert.equal(r.status, 'ok');
        assert.equal(r.authSent, false);
    } finally { await cam.close(); }
});

test('계정을 주지 않으면 401은 authSent=false 로 끝난다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1' });
        assert.equal(r.status, 'unauthorized');
        assert.equal(r.authSent, false);
        assert.match(r.headers['www-authenticate'], /Digest realm="mock"/);
    } finally { await cam.close(); }
});

test('쿼리가 있는 경로도 처리한다', async () => {
    const p = '/cam/realmonitor?channel=1&subtype=0';
    const cam = await createMockRtsp({ validPaths: [p] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: p, username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('닫힌 포트는 unreachable', async () => {
    const port = await getClosedPort();
    const r = await describe({ host: HOST, port, path: '/x', username: 'a', password: 'b', timeoutMs: 500 });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.authSent, false);
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/rtsp-probe.test.js`
Expected: FAIL (`Cannot find module '../finder/rtsp-probe'`)

- [ ] **Step 4: 구현**

`backend/finder/rtsp-probe.js`:

```js
'use strict';
const net = require('net');
const crypto = require('crypto');

/**
 * RTSP DESCRIBE 를 소켓으로 직접 보내 응답 코드를 분류한다.
 * - 200 ok / 401 unauthorized / 404 not_found / 그 외 other / 연결 실패 unreachable
 * - authSent: 아이디/비밀번호를 실어 보낸 요청의 결과인지 (인증 실패 예산 계산에 쓴다)
 */

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

function sendRaw(host, port, request, timeoutMs) {
    return new Promise(resolve => {
        const chunks = [];
        let settled = false;
        const socket = net.connect({ host, port });
        const finish = result => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };
        const collected = () => Buffer.concat(chunks);
        socket.setTimeout(timeoutMs, () => (chunks.length ? finish({ ok: true, raw: collected() }) : finish({ ok: false, reason: 'timeout' })));
        socket.on('connect', () => socket.write(request));
        socket.on('data', d => {
            chunks.push(d);
            if (collected().toString('latin1').includes('\r\n\r\n')) finish({ ok: true, raw: collected() });
        });
        socket.on('end', () => finish(chunks.length ? { ok: true, raw: collected() } : { ok: false, reason: 'closed' }));
        socket.on('error', err => finish({ ok: false, reason: err.code || 'error' }));
    });
}

function buildRequest(uri, cseq, extraHeaders) {
    return `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: CCTVGO-Finder\r\nAccept: application/sdp\r\n${extraHeaders}\r\n`;
}

function parseResponse(raw) {
    const text = raw.toString('latin1');
    const end = text.indexOf('\r\n\r\n');
    const lines = (end >= 0 ? text.slice(0, end) : text).split('\r\n');
    const m = /^RTSP\/\d\.\d\s+(\d{3})/.exec(lines[0] || '');
    if (!m) return null;
    const headers = {};
    for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    return { code: Number(m[1]), headers };
}

/** WWW-Authenticate 값에서 Digest(우선) 또는 Basic 챌린지를 뽑는다 */
function parseChallenge(value) {
    if (!value) return null;
    const digestAt = value.search(/digest\s/i);
    if (digestAt >= 0) {
        const part = value.slice(digestAt + 7).split(/,\s*basic\s/i)[0];
        const params = {};
        const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
        let m;
        while ((m = re.exec(part))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
        return { scheme: 'digest', ...params };
    }
    const basic = /basic\s+realm="?([^",]*)"?/i.exec(value);
    return basic ? { scheme: 'basic', realm: basic[1] } : null;
}

function buildAuthHeader(challenge, username, password, uri) {
    if (challenge.scheme === 'basic') {
        return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    const ha1 = md5(`${username}:${challenge.realm}:${password}`);
    const ha2 = md5(`DESCRIBE:${uri}`);
    let response;
    let extra = '';
    if (challenge.qop && /auth/.test(challenge.qop)) {
        const nc = '00000001';
        const cnonce = crypto.randomBytes(8).toString('hex');
        response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
        extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
        response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }
    const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : '';
    return `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"${extra}${opaque}`;
}

function classify(resp, authSent, extraHeaders) {
    let status = 'other';
    if (resp.code === 200) status = 'ok';
    else if (resp.code === 401) status = 'unauthorized';
    else if (resp.code === 404) status = 'not_found';
    return { status, code: resp.code, authSent, headers: { ...(extraHeaders || {}), ...resp.headers } };
}

async function describe({ host, port, path, username = '', password = '', timeoutMs = 2000 }) {
    const uri = `rtsp://${host}:${port}${path.startsWith('/') ? path : '/' + path}`;

    const first = await sendRaw(host, port, buildRequest(uri, 1, ''), timeoutMs);
    if (!first.ok) return { status: 'unreachable', reason: first.reason, authSent: false };
    const r1 = parseResponse(first.raw);
    if (!r1) return { status: 'other', code: 0, authSent: false, headers: {} };
    if (r1.code !== 401 || !username) return classify(r1, false);

    const challenge = parseChallenge(r1.headers['www-authenticate']);
    if (!challenge) return classify(r1, false);

    const auth = buildAuthHeader(challenge, username, password, uri);
    const second = await sendRaw(host, port, buildRequest(uri, 2, `Authorization: ${auth}\r\n`), timeoutMs);
    if (!second.ok) return { status: 'unreachable', reason: second.reason, authSent: true };
    const r2 = parseResponse(second.raw);
    if (!r2) return { status: 'other', code: 0, authSent: true, headers: r1.headers };
    return classify(r2, true, r1.headers);
}

module.exports = { describe, parseChallenge };
```

- [ ] **Step 5: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/rtsp-probe.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: 커밋**

```bash
cd /c/cctvgo && git add backend/finder/rtsp-probe.js backend/tests/rtsp-probe.test.js backend/tests/helpers/mock-rtsp.js backend/tests/helpers/ports.js
git commit -m "카메라 찾기: RTSP DESCRIBE 탐침(Basic/Digest)과 mock 카메라" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: scan 모듈 (서브넷 스캔 + WS-Discovery)

**Files:**
- Create: `backend/finder/scan.js`
- Test: `backend/tests/scan.test.js`

**Interfaces:**
- Consumes: `isPrivateIPv4` from `./guard`
- Produces: `RTSP_PORTS`, `tcpOpen`, `subnetHosts`, `getLocalSubnets`, `scanHosts`, `wsDiscovery`, `parseDiscovery`, `mergeScanResults`, `scanNetwork` (계약 참조)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/scan.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { subnetHosts, tcpOpen, scanHosts, parseDiscovery, mergeScanResults, scanNetwork } = require('../finder/scan');
const { getClosedPort } = require('./helpers/ports');

function listen() {
    return new Promise(resolve => {
        const s = net.createServer(sock => sock.end());
        s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise(r => s.close(r)) }));
    });
}

test('subnetHosts: /24는 .0/.255와 자기 자신을 뺀 253개', () => {
    const hosts = subnetHosts('192.168.0.10', '255.255.255.0');
    assert.equal(hosts.length, 253);
    assert.ok(hosts.includes('192.168.0.1') && hosts.includes('192.168.0.254'));
    assert.ok(!hosts.includes('192.168.0.10') && !hosts.includes('192.168.0.0') && !hosts.includes('192.168.0.255'));
});

test('subnetHosts: /16 이하는 자신이 속한 /24로 제한한다', () => {
    const hosts = subnetHosts('10.1.2.50', '255.255.0.0');
    assert.equal(hosts.length, 253);
    assert.ok(hosts.every(h => h.startsWith('10.1.2.')));
});

test('subnetHosts: /30 은 실제 호스트만', () => {
    assert.deepEqual(subnetHosts('192.168.0.1', '255.255.255.252'), ['192.168.0.2']);
});

test('tcpOpen: 열린 포트 true, 닫힌 포트 false', async () => {
    const srv = await listen();
    const closed = await getClosedPort();
    try {
        assert.equal(await tcpOpen('127.0.0.1', srv.port, 500), true);
        assert.equal(await tcpOpen('127.0.0.1', closed, 500), false);
    } finally { await srv.close(); }
});

test('scanHosts: 열린 포트가 있는 호스트만 돌려준다', async () => {
    const srv = await listen();
    const closed = await getClosedPort();
    try {
        const r = await scanHosts(['127.0.0.1'], [closed, srv.port], { timeoutMs: 500 });
        assert.deepEqual(r, [{ ip: '127.0.0.1', ports: [srv.port] }]);
    } finally { await srv.close(); }
});

test('parseDiscovery: ONVIF scope에서 제조사/모델을 뽑는다', () => {
    const xml = '<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Hik%20vision onvif://www.onvif.org/hardware/DS-2CD2</d:Scopes>';
    assert.deepEqual(parseDiscovery(xml), { vendor: 'Hik vision', model: 'DS-2CD2' });
    assert.deepEqual(parseDiscovery('<x/>'), { vendor: null, model: null });
});

test('mergeScanResults: 포트 스캔과 Discovery 결과를 IP 기준으로 합친다', () => {
    const merged = mergeScanResults(
        [{ ip: '192.168.0.20', ports: [554] }, { ip: '192.168.0.3', ports: [8554] }],
        [{ ip: '192.168.0.20', vendor: 'Hikvision', model: 'X' }, { ip: '192.168.0.5', vendor: 'Dahua', model: null }, { ip: '8.8.8.8', vendor: 'evil', model: null }]
    );
    assert.deepEqual(merged.map(m => m.ip), ['192.168.0.3', '192.168.0.5', '192.168.0.20']);
    const cam20 = merged.find(m => m.ip === '192.168.0.20');
    assert.deepEqual(cam20, { ip: '192.168.0.20', ports: [554], vendor: 'Hikvision', model: 'X', onvif: true });
    assert.deepEqual(merged.find(m => m.ip === '192.168.0.5').ports, []);
    assert.equal(merged.find(m => m.ip === '192.168.0.3').onvif, false);
});

test('scanNetwork: 주입한 서브넷과 discovery 로 동작한다', async () => {
    const srv = await listen();
    try {
        const r = await scanNetwork({
            subnets: [{ hosts: ['127.0.0.1'] }],
            ports: [srv.port],
            discover: async () => [{ ip: '192.168.0.5', vendor: 'X', model: 'Y' }],
        });
        assert.deepEqual(r.map(c => c.ip).sort(), ['127.0.0.1', '192.168.0.5']);
    } finally { await srv.close(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/scan.test.js`
Expected: FAIL (`Cannot find module '../finder/scan'`)

- [ ] **Step 3: 구현**

`backend/finder/scan.js`:

```js
'use strict';
const net = require('net');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { isPrivateIPv4 } = require('./guard');

/**
 * 카메라 후보 탐색
 * - 서버 NIC의 사설 서브넷(최대 /24)을 RTSP 포트로 스캔한다.
 * - ONVIF WS-Discovery(UDP 멀티캐스트)로 제조사/모델 힌트를 보강한다 (실패해도 스캔은 계속).
 */

const RTSP_PORTS = [554, 8554, 88, 10554];

function ipToInt(ip) {
    return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

function intToIp(n) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function prefixLength(netmask) {
    return ipToInt(netmask).toString(2).split('').filter(c => c === '1').length;
}

/** address 가 속한 서브넷의 호스트 IP 목록 (prefix가 24보다 작아도 /24로 제한, 자기 자신 제외) */
function subnetHosts(address, netmask) {
    const prefix = Math.max(24, prefixLength(netmask));
    const size = Math.pow(2, 32 - prefix);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = (ipToInt(address) & mask) >>> 0;
    const hosts = [];
    for (let i = 1; i < size - 1; i++) {
        const ip = intToIp(network + i);
        if (ip !== address) hosts.push(ip);
    }
    return hosts;
}

function getLocalSubnets() {
    const result = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            const isV4 = a.family === 'IPv4' || a.family === 4;
            if (!isV4 || a.internal || !isPrivateIPv4(a.address)) continue;
            result.push({ address: a.address, netmask: a.netmask, hosts: subnetHosts(a.address, a.netmask) });
        }
    }
    return result;
}

function tcpOpen(host, port, timeoutMs = 500) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        let done = false;
        const end = ok => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => end(false));
        socket.on('connect', () => end(true));
        socket.on('error', () => end(false));
    });
}

async function scanHosts(hosts, ports, { concurrency = 64, timeoutMs = 500 } = {}) {
    const tasks = [];
    for (const h of hosts) for (const p of ports) tasks.push([h, p]);
    const open = new Map();
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const [h, p] = tasks[next++];
            if (await tcpOpen(h, p, timeoutMs)) {
                if (!open.has(h)) open.set(h, []);
                open.get(h).push(p);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return Array.from(open.entries())
        .map(([ip, openPorts]) => ({ ip, ports: openPorts.sort((a, b) => a - b) }))
        .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

function parseDiscovery(xml) {
    const scopes = (/<(?:\w+:)?Scopes[^>]*>([^<]*)</.exec(xml) || [])[1] || '';
    const pick = key => {
        const m = new RegExp('onvif://www\\.onvif\\.org/' + key + '/(\\S+)', 'i').exec(scopes);
        if (!m) return null;
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    };
    return { vendor: pick('name'), model: pick('hardware') };
}

/** ONVIF WS-Discovery Probe. 어떤 오류든 빈 배열로 끝낸다. */
function wsDiscovery({ timeoutMs = 2000 } = {}) {
    return new Promise(resolve => {
        const found = new Map();
        let socket;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            try { socket.close(); } catch (e) { /* 이미 닫힘 */ }
            resolve(Array.from(found.entries()).map(([ip, info]) => ({ ip, ...info })));
        };
        try {
            socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch (e) {
            return resolve([]);
        }
        const probe = '<?xml version="1.0" encoding="UTF-8"?>'
            + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
            + `<e:Header><w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>`
            + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
        socket.on('message', (msg, rinfo) => found.set(rinfo.address, parseDiscovery(msg.toString('utf8'))));
        socket.on('error', finish);
        socket.bind(0, () => {
            try { socket.send(probe, 3702, '239.255.255.250'); } catch (e) { finish(); }
        });
        setTimeout(finish, timeoutMs);
    });
}

function mergeScanResults(open, discovered) {
    const map = new Map();
    for (const o of open) map.set(o.ip, { ip: o.ip, ports: o.ports, vendor: null, model: null, onvif: false });
    for (const d of discovered) {
        if (!isPrivateIPv4(d.ip)) continue;
        const entry = map.get(d.ip) || { ip: d.ip, ports: [], vendor: null, model: null, onvif: false };
        entry.vendor = d.vendor || entry.vendor;
        entry.model = d.model || entry.model;
        entry.onvif = true;
        map.set(d.ip, entry);
    }
    return Array.from(map.values()).sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

async function scanNetwork({ ports = RTSP_PORTS, subnets = getLocalSubnets(), discover = wsDiscovery } = {}) {
    const hosts = subnets.flatMap(s => s.hosts);
    const [open, discovered] = await Promise.all([scanHosts(hosts, ports), discover()]);
    return mergeScanResults(open, discovered);
}

module.exports = {
    RTSP_PORTS, subnetHosts, getLocalSubnets, tcpOpen, scanHosts,
    parseDiscovery, wsDiscovery, mergeScanResults, scanNetwork,
};
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/scan.test.js`
Expected: PASS (8 tests). `subnetHosts` /24 테스트의 기대값 253은 호스트 254개(.1~.254)에서 자기 자신 1개를 뺀 값이다.

- [ ] **Step 5: 커밋**

```bash
cd /c/cctvgo && git add backend/finder/scan.js backend/tests/scan.test.js
git commit -m "카메라 찾기: 서브넷 포트 스캔과 WS-Discovery" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: onvif 모듈 + mock ONVIF 서버

**Files:**
- Create: `backend/finder/onvif.js`
- Create: `backend/tests/helpers/mock-onvif.js`
- Test: `backend/tests/onvif.test.js`

**Interfaces:**
- Consumes: `tcpOpen` from `./scan`
- Produces: `getStreamUris({host, username, password, ports, servicePaths, timeoutMs?})`, `parseUtcOffset`, `parseProfiles`, `parseUri` (계약 참조), 테스트 헬퍼 `createMockOnvif`

- [ ] **Step 1: mock ONVIF 서버 작성**

`backend/tests/helpers/mock-onvif.js`:

```js
'use strict';
const http = require('http');
const crypto = require('crypto');

/**
 * 테스트용 가짜 ONVIF 카메라 (device_service / media_service).
 * - clockOffsetMs: 카메라 시계가 서버보다 얼마나 앞서는지. WS-Security Created 가 maxSkewMs 를 넘으면 거절한다.
 * - GetProfiles / GetStreamUri 는 인증 필수(requireAuth). 실패하면 NotAuthorized Fault (state.failedAuth 증가)
 * - 스트림 주소는 일부러 rtsp://0.0.0.0:<rtspPort>/... 로 돌려준다 (실제 카메라의 잘못된 주소 재현)
 */
async function createMockOnvif({
    users = { admin: 'pw' },
    requireAuth = true,
    clockOffsetMs = 0,
    maxSkewMs = 5000,
    rtspPort = 554,
    profiles = [
        { token: 'p1', name: 'main', path: '/onvif/profile1' },
        { token: 'p2', name: 'sub', path: '/onvif/profile2' },
    ],
    host = '127.0.0.1',
} = {}) {
    const state = { requests: [], failedAuth: 0 };
    const wrap = inner => '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        + 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
        + `xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${inner}</s:Body></s:Envelope>`;
    const notAuthorized = () => wrap('<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code>'
        + '<s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault>');

    function authorized(body) {
        const pick = tag => {
            const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)<`).exec(body);
            return m ? m[1] : null;
        };
        const user = pick('Username');
        const digest = pick('Password');
        const nonce = pick('Nonce');
        const created = pick('Created');
        if (!user || !digest || !nonce || !created || users[user] === undefined) return false;
        const expected = crypto.createHash('sha1')
            .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(users[user])]))
            .digest('base64');
        if (expected !== digest) return false;
        return Math.abs(Date.parse(created) - (Date.now() + clockOffsetMs)) <= maxSkewMs;
    }

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const op = (/<(?:\w+:)?(GetSystemDateAndTime|GetCapabilities|GetProfiles|GetStreamUri)\b/.exec(body) || [])[1];
            state.requests.push({ path: req.url, op });
            if (req.method !== 'POST' || !['/onvif/device_service', '/onvif/media_service'].includes(req.url) || !op) {
                res.writeHead(404);
                return res.end();
            }
            const send = (code, xml) => {
                res.writeHead(code, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
                res.end(xml);
            };
            if (op === 'GetSystemDateAndTime') {
                const d = new Date(Date.now() + clockOffsetMs);
                return send(200, wrap('<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>'
                    + `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`
                    + `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>`
                    + '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'));
            }
            if (op === 'GetCapabilities') {
                return send(200, wrap('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media>'
                    + `<tt:XAddr>http://0.0.0.0:${server.address().port}/onvif/media_service</tt:XAddr>`
                    + '</tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>'));
            }
            if (requireAuth && !authorized(body)) {
                state.failedAuth++;
                return send(400, notAuthorized());
            }
            if (op === 'GetProfiles') {
                const items = profiles.map(p => `<trt:Profiles token="${p.token}" fixed="true"><tt:Name>${p.name}</tt:Name>`
                    + '<tt:VideoSourceConfiguration token="v1"><tt:Name>vsrc</tt:Name></tt:VideoSourceConfiguration></trt:Profiles>').join('');
                return send(200, wrap(`<trt:GetProfilesResponse>${items}</trt:GetProfilesResponse>`));
            }
            const token = (/<(?:\w+:)?ProfileToken>([^<]+)</.exec(body) || [])[1];
            const profile = profiles.find(p => p.token === token);
            if (!profile) return send(400, wrap('<s:Fault><s:Reason><s:Text>NoProfile</s:Text></s:Reason></s:Fault>'));
            return send(200, wrap('<trt:GetStreamUriResponse><trt:MediaUri>'
                + `<tt:Uri>rtsp://0.0.0.0:${rtspPort}${profile.path}</tt:Uri>`
                + '</trt:MediaUri></trt:GetStreamUriResponse>'));
        });
    });

    await new Promise(resolve => server.listen(0, host, resolve));
    return {
        port: server.address().port,
        state,
        close: () => new Promise(resolve => { server.close(resolve); if (server.closeAllConnections) server.closeAllConnections(); }),
    };
}

module.exports = { createMockOnvif };
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/onvif.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getStreamUris, parseUtcOffset, parseProfiles, parseUri } = require('../finder/onvif');
const { createMockOnvif } = require('./helpers/mock-onvif');
const { getClosedPort } = require('./helpers/ports');

const HOST = '127.0.0.1';
const SERVICE = ['/onvif/device_service'];

test('parseUtcOffset: 네임스페이스 접두사와 관계없이 카메라 시각과의 차이를 계산한다', () => {
    const future = new Date(Date.now() + 3600 * 1000);
    const xml = `<a:UTCDateTime><b:Time><b:Hour>${future.getUTCHours()}</b:Hour><b:Minute>${future.getUTCMinutes()}</b:Minute><b:Second>${future.getUTCSeconds()}</b:Second></b:Time>`
        + `<b:Date><b:Year>${future.getUTCFullYear()}</b:Year><b:Month>${future.getUTCMonth() + 1}</b:Month><b:Day>${future.getUTCDate()}</b:Day></b:Date></a:UTCDateTime>`;
    const offset = parseUtcOffset(xml);
    assert.ok(Math.abs(offset - 3600 * 1000) < 2000, String(offset));
    assert.equal(parseUtcOffset('<x/>'), null);
});

test('parseProfiles / parseUri', () => {
    const xml = '<trt:Profiles token="p1"><tt:Name>main</tt:Name><tt:VideoSourceConfiguration><tt:Name>v</tt:Name></tt:VideoSourceConfiguration></trt:Profiles>'
        + '<trt:Profiles token="p2" fixed="true"><tt:Name>sub</tt:Name></trt:Profiles>';
    assert.deepEqual(parseProfiles(xml), [{ token: 'p1', name: 'main' }, { token: 'p2', name: 'sub' }]);
    assert.equal(parseUri('<tt:Uri>rtsp://1.2.3.4:554/a?b=1&amp;c=2</tt:Uri>'), 'rtsp://1.2.3.4:554/a?b=1&c=2');
    assert.equal(parseUri('<x/>'), null);
});

test('올바른 계정이면 프로파일별 스트림 URI를 돌려준다', async () => {
    const cam = await createMockOnvif({ rtspPort: 5540 });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.uris.map(u => u.name), ['main', 'sub']);
        assert.equal(r.uris[0].uri, 'rtsp://0.0.0.0:5540/onvif/profile1');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('카메라 시계가 10분 어긋나 있어도 시차를 보정해 인증한다', async () => {
    const cam = await createMockOnvif({ clockOffsetMs: 10 * 60 * 1000 });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 auth_failed 이고 인증 요청은 1번만 보낸다', async () => {
    const cam = await createMockOnvif();
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'wrong', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'auth_failed');
        assert.equal(cam.state.failedAuth, 1);
    } finally { await cam.close(); }
});

test('ONVIF가 없으면 unsupported', async () => {
    const closed = await getClosedPort();
    const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [closed], servicePaths: SERVICE, timeoutMs: 500 });
    assert.deepEqual(r, { status: 'unsupported' });
});

test('SOAP이 아닌 웹서버(404)는 unsupported 이고 인증 실패로 세지 않는다', async () => {
    const http = require('http');
    const web = http.createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cam"' }); res.end(); });
    await new Promise(r => web.listen(0, HOST, r));
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [web.address().port], servicePaths: SERVICE, timeoutMs: 1000 });
        assert.deepEqual(r, { status: 'unsupported' });
    } finally { web.close(); }
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/onvif.test.js`
Expected: FAIL (`Cannot find module '../finder/onvif'`)

- [ ] **Step 4: 구현**

`backend/finder/onvif.js`:

```js
'use strict';
const http = require('http');
const crypto = require('crypto');
const { tcpOpen } = require('./scan');

/**
 * ONVIF 유니캐스트 SOAP 로 스트림 URI를 받아온다.
 * - 인증이 필요한 요청(GetProfiles/GetStreamUri)은 WS-Security UsernameToken(PasswordDigest)를 쓴다.
 * - 카메라와 서버의 시계 오차는 GetSystemDateAndTime 으로 보정한다.
 * - NotAuthorized Fault 를 받으면 즉시 auth_failed 로 끝낸다 (재시도하지 않는다: 계정 잠금 방지).
 * - SOAP 이 아닌 응답(404, HTTP 401 등)은 unsupported 로 보고 인증 실패로 세지 않는다.
 */

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
    + 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"';

const xmlEscape = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const decodeXml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function securityHeader(username, password, offsetMs) {
    const nonce = crypto.randomBytes(16);
    const created = new Date(Date.now() + offsetMs).toISOString().split('.')[0] + 'Z';
    const digest = crypto.createHash('sha1')
        .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
        .digest('base64');
    return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        + `<UsernameToken><Username>${xmlEscape(username)}</Username>`
        + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
        + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
        + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
        + '</UsernameToken></Security></s:Header>';
}

function soapRequest({ host, port, path, body, auth, offsetMs = 0, timeoutMs = 3000 }) {
    return new Promise(resolve => {
        const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope ${NS}>`
            + `${auth ? securityHeader(auth.username, auth.password, offsetMs) : ''}<s:Body>${body}</s:Body></s:Envelope>`;
        const req = http.request({
            host, port, path, method: 'POST', timeout: timeoutMs,
            headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(envelope) },
        }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve({ ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        req.on('error', err => resolve({ ok: false, reason: err.code || 'error' }));
        req.end(envelope);
    });
}

const isEnvelope = text => /<(?:\w+:)?Envelope\b/i.test(text);
const isNotAuthorized = text => /NotAuthorized|not authorized/i.test(text);

/** 카메라 UTC 시각 - 서버 시각 (ms). 파싱할 수 없으면 null */
function parseUtcOffset(xml) {
    const block = /<(?:\w+:)?UTCDateTime[\s\S]*?<\/(?:\w+:)?UTCDateTime>/.exec(xml);
    if (!block) return null;
    const get = tag => {
        const m = new RegExp(`<(?:\\w+:)?${tag}>(\\d+)<`).exec(block[0]);
        return m ? Number(m[1]) : null;
    };
    const [y, mo, d, h, mi, s] = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(get);
    if ([y, mo, d, h, mi, s].some(v => v === null)) return null;
    return Date.UTC(y, mo - 1, d, h, mi, s) - Date.now();
}

function parseProfiles(xml) {
    return xml.split(/<(?:\w+:)?Profiles\b/).slice(1).map(chunk => {
        const token = (/token="([^"]+)"/.exec(chunk) || [])[1];
        const name = (/<(?:\w+:)?Name>([^<]*)</.exec(chunk) || [])[1];
        return token ? { token: decodeXml(token), name: decodeXml(name || '') } : null;
    }).filter(Boolean);
}

function parseUri(xml) {
    const m = /<(?:\w+:)?Uri>([^<]+)</.exec(xml);
    return m ? decodeXml(m[1].trim()) : null;
}

async function tryEndpoint({ host, port, servicePath, username, password, timeoutMs }) {
    const time = await soapRequest({ host, port, path: servicePath, body: '<tds:GetSystemDateAndTime/>', timeoutMs });
    if (!time.ok || !isEnvelope(time.text)) return { status: 'unsupported' };
    const parsedOffset = parseUtcOffset(time.text);
    const offsetMs = parsedOffset === null ? 0 : parsedOffset;

    // 미디어 서비스 경로: Capabilities 의 XAddr 경로만 사용한다 (호스트는 무시하고 항상 요청한 IP/포트 사용)
    const mediaPaths = [];
    const caps = await soapRequest({
        host, port, path: servicePath, timeoutMs,
        body: '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
    });
    if (caps.ok && isEnvelope(caps.text)) {
        const m = /<(?:\w+:)?Media>[\s\S]*?<(?:\w+:)?XAddr>([^<]+)</.exec(caps.text);
        if (m) {
            try { mediaPaths.push(new URL(decodeXml(m[1].trim())).pathname); } catch (e) { /* 무시 */ }
        }
    }
    for (const p of ['/onvif/media_service', '/onvif/media', servicePath]) {
        if (!mediaPaths.includes(p)) mediaPaths.push(p);
    }

    const auth = { username, password };
    for (const mediaPath of mediaPaths) {
        const pr = await soapRequest({ host, port, path: mediaPath, body: '<trt:GetProfiles/>', auth, offsetMs, timeoutMs });
        if (!pr.ok || !isEnvelope(pr.text)) continue;
        if (isNotAuthorized(pr.text)) return { status: 'auth_failed' };
        const profiles = parseProfiles(pr.text);
        if (profiles.length === 0) continue;

        const uris = [];
        for (const profile of profiles.slice(0, 4)) {
            const body = '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
                + '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
                + `<trt:ProfileToken>${xmlEscape(profile.token)}</trt:ProfileToken></trt:GetStreamUri>`;
            const ur = await soapRequest({ host, port, path: mediaPath, body, auth, offsetMs, timeoutMs });
            if (!ur.ok || !isEnvelope(ur.text) || isNotAuthorized(ur.text)) continue;
            const uri = parseUri(ur.text);
            if (uri) uris.push({ token: profile.token, name: profile.name, uri });
        }
        if (uris.length) return { status: 'ok', uris };
    }
    return { status: 'unsupported' };
}

async function getStreamUris({ host, username, password, ports, servicePaths, timeoutMs = 3000 }) {
    for (const port of ports) {
        if (!(await tcpOpen(host, port, 500))) continue;
        for (const servicePath of servicePaths) {
            const result = await tryEndpoint({ host, port, servicePath, username, password, timeoutMs });
            if (result.status !== 'unsupported') return result;
        }
    }
    return { status: 'unsupported' };
}

module.exports = { getStreamUris, parseUtcOffset, parseProfiles, parseUri };
```

- [ ] **Step 5: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/onvif.test.js`
Expected: PASS (7 tests). `mock-onvif`의 `close`가 keep-alive 연결 때문에 지연되면 `closeAllConnections`(Node 18.2+)가 처리한다.

- [ ] **Step 6: 커밋**

```bash
cd /c/cctvgo && git add backend/finder/onvif.js backend/tests/onvif.test.js backend/tests/helpers/mock-onvif.js
git commit -m "카메라 찾기: ONVIF GetStreamUri(WS-Security, 시계 오차 보정)와 mock 카메라" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: find-stream 오케스트레이션 (예산, 성향 감지, 진단)

**Files:**
- Create: `backend/finder/find-stream.js`
- Test: `backend/tests/find-stream.test.js`

**Interfaces:**
- Consumes: `describe` (rtsp-probe), `getStreamUris` (onvif), `tcpOpen`, `RTSP_PORTS` (scan), `buildRtspUrl` (cctv-file), `orderedPaths` (paths), `AuthBudget` 메서드 (guard)
- Produces: `findStream(opts)` (계약 참조), `BOGUS_PATH`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/find-stream.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findStream, BOGUS_PATH } = require('../finder/find-stream');
const { AuthBudget } = require('../finder/guard');
const { createMockRtsp } = require('./helpers/mock-rtsp');
const { createMockOnvif } = require('./helpers/mock-onvif');

const HOST = '127.0.0.1';
const paths = list => list.map(p => ({ path: p, vendors: [] }));
const settingsFor = (list, onvifPorts = []) => ({ paths: paths(list), onvifPorts, onvifServicePaths: ['/onvif/device_service'] });

function run(cam, extra = {}) {
    return findStream({
        host: HOST,
        username: 'admin',
        password: 'pw',
        budget: new AuthBudget(),
        settings: settingsFor(['/a', '/b', '/c']),
        rtspPorts: [cam.port],
        rtspTimeoutMs: 1000,
        onvifTimeoutMs: 1000,
        ...extra,
    });
}

test('잘못된 경로에 404를 주는 카메라: 후보를 끝까지 시도해 찾고 인증 실패는 0회', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/b`);
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
        assert.ok(cam.state.requests.some(q => q.path === BOGUS_PATH), '성향 감지 요청을 보냈다');
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 인증 실패는 최대 2회에서 멈춘다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { password: 'wrong', budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, 2);
        assert.equal(budget.isExhausted(HOST), true);
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라: 예산(2회) 안에서만 시도한다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'], unknownPathStatus: 401 });
    try {
        const r = await run(cam);   // 후보 순서 /a,/b,/c → 성향 감지 1회 + /a 1회로 예산 소진
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, 2);
        assert.ok(!cam.state.requests.some(q => q.path === '/b' && q.authed), '/b 는 시도하지 않는다');
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라라도 첫 후보가 맞으면 찾는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'], unknownPathStatus: 401 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/a`);
        assert.equal(budget.failures(HOST), 0, '성공하면 예산을 초기화한다');
    } finally { await cam.close(); }
});

test('예산이 소진된 카메라에는 어떤 요청도 보내지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        budget.recordFailure(HOST); budget.recordFailure(HOST);
        const r = await run(cam, { budget });
        assert.equal(r.status, 'auth_locked');
        assert.ok(r.retryAfterSec > 0);
        assert.equal(cam.state.requests.length, 0);
    } finally { await cam.close(); }
});

test('인증이 필요 없는 카메라는 계정 없이 찾는다', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/c'] });
    try {
        const r = await run(cam, { username: '', password: '' });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://${HOST}:${cam.port}/c`);
    } finally { await cam.close(); }
});

test('계정 없이 인증이 필요한 카메라는 auth_failed (요청 예산 소모 없음)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { username: '', password: '', budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(budget.failures(HOST), 0);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('직접 입력 경로: 맞으면 found(manual), 틀리면 path_not_found', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const ok = await run(cam, { path: '/b', port: cam.port });
        assert.equal(ok.status, 'found');
        assert.equal(ok.candidates[0].source, 'manual');
        const bad = await run(cam, { path: '/zzz', port: cam.port });
        assert.equal(bad.status, 'path_not_found');
    } finally { await cam.close(); }
});

test('열린 RTSP 포트가 없으면 unreachable', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    const port = cam.port;
    await cam.close();
    const r = await run({ port }, {});
    assert.equal(r.status, 'unreachable');
});

test('ONVIF: 주소를 받아 재검증하고 성향 감지 없이 찾는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/onvif/profile1', '/onvif/profile2'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.deepEqual(r.candidates.map(c => c.source), ['onvif', 'onvif']);
        assert.deepEqual(r.candidates.map(c => c.label), ['main', 'sub']);
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/onvif/profile1`);
        assert.ok(!rtsp.state.requests.some(q => q.path === BOGUS_PATH));
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF가 알려 준 주소가 실제로 접속되지 않으면 채택하지 않고 경로 후보로 폴백한다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });   // ONVIF 가 알려 주는 /onvif/profile* 는 없음
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/b`);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF 인증 실패 + RTSP 인증 실패를 합쳐도 카메라가 본 인증 실패는 2회 이하', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        const r = await run(rtsp, { password: 'wrong', budget, settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.ok(onvif.state.failedAuth + rtsp.state.failedAuth <= 2, `${onvif.state.failedAuth}+${rtsp.state.failedAuth}`);
        assert.equal(budget.isExhausted(HOST), true);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('진단 정보에는 호스트/서버 헤더/시도 목록이 있고 비밀번호는 없다', async () => {
    const cam = await createMockRtsp({ users: { admin: 'S3cr3t!x' }, validPaths: ['/nothing'] });
    try {
        const r = await run(cam, { password: 'S3cr3t!x', vendorHint: 'Acme Cam' });
        assert.equal(r.status, 'path_not_found');
        assert.match(r.diagnostics, /카메라 IP: 127\.0\.0\.1/);
        assert.match(r.diagnostics, /Acme Cam/);
        assert.match(r.diagnostics, /MockCam\/1\.0/);
        assert.match(r.diagnostics, /realm/i);
        assert.match(r.diagnostics, /\/a → 404/);
        assert.ok(!r.diagnostics.includes('S3cr3t'));
        assert.ok(!JSON.stringify(r.tried).includes('S3cr3t'));
    } finally { await cam.close(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/find-stream.test.js`
Expected: FAIL (`Cannot find module '../finder/find-stream'`)

- [ ] **Step 3: 구현**

`backend/finder/find-stream.js`:

```js
'use strict';
const { describe } = require('./rtsp-probe');
const onvif = require('./onvif');
const { tcpOpen, RTSP_PORTS } = require('./scan');
const { buildRtspUrl } = require('./cctv-file');
const { orderedPaths } = require('./paths');

/**
 * 카메라 RTSP URL 탐색 오케스트레이션.
 *
 * 순서: ONVIF GetStreamUri(재검증) → 존재하지 않는 경로로 카메라 성향 감지 → 경로 후보 DESCRIBE
 *
 * 계정 잠금 방지 (budget = AuthBudget, IP별 인증 실패 2회):
 * - 아이디/비밀번호를 실어 보낸 요청이 401이면 실패 1회로 센다 (ONVIF NotAuthorized 포함).
 * - 성향 감지: 없는 경로에 404 → 계정은 맞고 이후 401은 비밀번호 오류로 확정(즉시 중단).
 *              없는 경로에 401 → 비밀번호 오류이거나 "경로가 틀려도 401을 주는" 카메라. 예산 안에서만 계속.
 */

const BOGUS_PATH = '/cctvgo-probe-test';

function buildDiagnostics(host, vendorHint, info, tried) {
    return [
        'CCTVGO 카메라 주소 찾기 진단 정보',
        `카메라 IP: ${host}`,
        `제조사/모델 힌트: ${vendorHint || '알 수 없음'}`,
        `열린 RTSP 포트: ${info.openPorts.length ? info.openPorts.join(', ') : '없음'}`,
        `RTSP Server 헤더: ${info.server || '알 수 없음'}`,
        `RTSP 인증 realm: ${info.realm || '알 수 없음'}`,
        `ONVIF: ${info.onvif}`,
        `시도한 항목 (${tried.length}개):`,
        ...tried.map(t => `  - [${t.kind}] ${t.target} → ${t.result}`),
    ].join('\n');
}

async function findStream({
    host, port, path, username = '', password = '', vendorHint = '',
    budget, settings, rtspPorts = RTSP_PORTS, rtspTimeoutMs = 2000, onvifTimeoutMs = 3000,
}) {
    const tried = [];
    const info = { server: null, realm: null, onvif: '시도 안 함', openPorts: [] };

    const finish = (status, extra = {}) => ({
        status, candidates: [], tried, diagnostics: buildDiagnostics(host, vendorHint, info, tried), ...extra,
    });
    const candidate = (rtspPort, p, source, label) => ({
        url: buildRtspUrl({ username, password, host, port: rtspPort, path: p }), source, label,
    });

    function noteHeaders(h) {
        if (!h) return;
        if (h.server) info.server = h.server;
        const m = /realm="([^"]*)"/i.exec(h['www-authenticate'] || '');
        if (m) info.realm = m[1];
    }

    /** DESCRIBE 1회. 로그인 실패(401)는 예산에 기록하고, 인증에 성공하면 예산을 초기화한다. */
    async function attempt(rtspPort, p) {
        const r = await describe({ host, port: rtspPort, path: p, username, password, timeoutMs: rtspTimeoutMs });
        tried.push({ kind: 'rtsp', target: `${rtspPort}${p}`, result: r.status === 'unreachable' ? `연결 실패(${r.reason})` : String(r.code) });
        noteHeaders(r.headers);
        if (r.authSent && r.status === 'unauthorized') budget.recordFailure(host);
        if (r.authSent && (r.status === 'ok' || r.status === 'not_found')) budget.reset(host);
        return r;
    }

    async function openRtspPorts() {
        const open = [];
        for (const p of rtspPorts) {
            if (await tcpOpen(host, p, 500)) open.push(p);
        }
        info.openPorts = open;
        return open;
    }

    if (budget.isExhausted(host)) {
        return finish('auth_locked', { retryAfterSec: Math.ceil(budget.retryAfterMs(host) / 1000) });
    }

    // --- 직접 입력한 경로 ---
    if (path) {
        const normalized = path.startsWith('/') ? path : '/' + path;
        const ports = port ? [port] : await openRtspPorts();
        if (ports.length === 0) return finish('unreachable');
        const r = await attempt(ports[0], normalized);
        if (r.status === 'ok') return finish('found', { candidates: [candidate(ports[0], normalized, 'manual', normalized)] });
        if (r.status === 'unreachable') return finish('unreachable');
        if (r.status === 'unauthorized') return finish('auth_failed', { ambiguous: true });
        return finish('path_not_found');
    }

    // --- 1) ONVIF ---
    const on = await onvif.getStreamUris({
        host, username, password, ports: settings.onvifPorts, servicePaths: settings.onvifServicePaths, timeoutMs: onvifTimeoutMs,
    });
    info.onvif = on.status === 'ok' ? `응답함 (프로파일 ${on.uris.length}개)` : on.status === 'auth_failed' ? '응답함, 인증 실패' : '응답 없음 또는 미지원';
    tried.push({ kind: 'onvif', target: host, result: on.status });

    if (on.status === 'ok') {
        const verified = [];
        for (const item of on.uris) {
            if (budget.isExhausted(host)) break;
            let u;
            try { u = new URL(item.uri); } catch (e) { continue; }
            const rtspPort = Number(u.port) || 554;
            const p = (u.pathname || '/') + (u.search || '');
            const r = await attempt(rtspPort, p);   // 카메라가 알려 준 주소라도 실제 접속을 확인한다
            if (r.status === 'ok') verified.push(candidate(rtspPort, p, 'onvif', item.name || item.token));
        }
        if (verified.length) return finish('found', { candidates: verified });
    } else if (on.status === 'auth_failed') {
        budget.recordFailure(host);
        if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: false });
    }

    // --- 2) 경로 후보 ---
    const ports = port ? [port] : await openRtspPorts();
    if (ports.length === 0) return finish('unreachable');
    const rtspPort = ports[0];
    if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: true });

    const bogus = await attempt(rtspPort, BOGUS_PATH);
    if (bogus.status === 'unreachable') return finish('unreachable');
    if (bogus.status === 'ok') {
        return finish('found', { candidates: [candidate(rtspPort, BOGUS_PATH, 'path', '(모든 경로에 응답하는 카메라)')] });
    }
    if (bogus.status === 'unauthorized' && !username) {
        return finish('auth_failed', { ambiguous: false });
    }
    const strict = bogus.status !== 'unauthorized';   // 없는 경로에 401이 아니면 계정은 맞다

    for (const p of orderedPaths(settings, vendorHint)) {
        if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: true });
        const r = await attempt(rtspPort, p);
        if (r.status === 'ok') return finish('found', { candidates: [candidate(rtspPort, p, 'path', p)] });
        if (r.status === 'unreachable') return finish('unreachable');
        if (r.status === 'unauthorized' && strict) return finish('auth_failed', { ambiguous: false });
    }
    return budget.isExhausted(host) ? finish('auth_failed', { ambiguous: true }) : finish('path_not_found');
}

module.exports = { findStream, BOGUS_PATH };
```

- [ ] **Step 4: 통과 확인**

Run: `cd C:\cctvgo\backend && node --test tests/find-stream.test.js`
Expected: PASS (12 tests). 실패하면 어떤 시나리오가 예산 규칙과 어긋나는지 `mock.state.requests`를 출력해 확인한다. 예산 규칙(카메라가 본 인증 실패 ≤ 2)은 바꾸지 않는다.

- [ ] **Step 5: 전체 테스트 확인 후 커밋**

Run: `cd C:\cctvgo\backend && npm test`
Expected: 지금까지의 모든 테스트 PASS

```bash
cd /c/cctvgo && git add backend/finder/find-stream.js backend/tests/find-stream.test.js
git commit -m "카메라 찾기: 탐색 오케스트레이션(ONVIF 우선, 성향 감지, 인증 실패 예산, 진단)" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: API 라우트 + server.js 연결

**Files:**
- Create: `backend/finder/routes.js`
- Modify: `backend/server.js` (라우트 등록 3줄, `get-channel-list` 라우트 바로 아래)
- Test: `backend/tests/routes.test.js`

**Interfaces:**
- Consumes: `isPrivateIPv4`, `AuthBudget`, `createRateLimiter`, `createLock` (guard); `parseCameras`, `saveCameraLine` (cctv-file); `loadSettings` (paths); `scanNetwork` (scan); `findStream` (find-stream)
- Produces: `registerFinderRoutes(app, {authMiddleware, baseDir, cctvPath, deps?, budget?})`
  - `POST /api/finder/scan` → `{status:'success', cameras:[...]}`
  - `POST /api/finder/probe` → findStream 결과 그대로
  - `GET /api/finder/cameras` → `{status:'success', cameras:[{index,name,host}]}` (비밀번호 미포함)
  - `POST /api/finder/save` → `{status:'success', restartRequired:true, index, backup}`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/routes.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { registerFinderRoutes } = require('../finder/routes');
const { AuthBudget } = require('../finder/guard');
const { parseCameras } = require('../finder/cctv-file');

async function startApp(deps = {}, cctvText = '# c\r\nrtsp://admin:secret@192.168.0.5:554/x, 거실') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-routes-'));
    const cctvPath = path.join(dir, 'cctv.txt');
    fs.writeFileSync(cctvPath, cctvText, 'utf8');
    const app = express();
    app.use(express.json());
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerFinderRoutes(app, { authMiddleware, baseDir: dir, cctvPath, deps, budget: new AuthBudget() });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, body, auth = true) => fetch(base + url, {
        method,
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-auth': 'ok' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { call, cctvPath, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

test('로그인하지 않으면 모든 finder API가 authMiddleware 에 막힌다', async () => {
    const app = await startApp();
    try {
        for (const [m, u] of [['POST', '/api/finder/scan'], ['POST', '/api/finder/probe'], ['GET', '/api/finder/cameras'], ['POST', '/api/finder/save']]) {
            const res = await app.call(m, u, m === 'POST' ? {} : undefined, false);
            assert.equal(res.status, 302, `${m} ${u}`);
        }
    } finally { await app.close(); }
});

test('probe: 공인 IP/호스트명/잘못된 포트/CRLF 경로는 400', async () => {
    let called = 0;
    const app = await startApp({ findStream: async () => { called++; return { status: 'found' }; } });
    try {
        for (const body of [
            { ip: '8.8.8.8', username: 'a', password: 'b' },
            { ip: 'camera.local', username: 'a', password: 'b' },
            { ip: '192.168.0.5', port: 70000 },
            { ip: '192.168.0.5', path: '/x\r\nEvil: 1' },
            { ip: '192.168.0.5', path: '/a b' },
        ]) {
            const res = await app.call('POST', '/api/finder/probe', body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        assert.equal(called, 0);
    } finally { await app.close(); }
});

test('probe: 검증을 통과하면 findStream 에 필요한 값을 넘기고 결과를 그대로 돌려준다', async () => {
    let args;
    const app = await startApp({ findStream: async a => { args = a; return { status: 'found', candidates: [{ url: 'rtsp://x' }], tried: [], diagnostics: '' }; } });
    try {
        const res = await app.call('POST', '/api/finder/probe', { ip: '192.168.0.5', port: '554', username: 'admin', password: 'pw', vendorHint: 'Hik', path: 'live' });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, 'found');
        assert.equal(args.host, '192.168.0.5');
        assert.equal(args.port, 554);
        assert.equal(args.username, 'admin');
        assert.equal(args.path, '/live');
        assert.ok(args.budget && args.settings && Array.isArray(args.settings.paths));
    } finally { await app.close(); }
});

test('probe: 요청 횟수 제한 (분당 20회 초과 시 429)', async () => {
    const app = await startApp();
    try {
        let last;
        for (let i = 0; i < 21; i++) last = await app.call('POST', '/api/finder/probe', { ip: '8.8.8.8' });
        assert.equal(last.status, 429);
    } finally { await app.close(); }
});

test('scan: 결과를 돌려주고 동시에 하나만 실행한다', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const app = await startApp({ scanNetwork: async () => { await gate; return [{ ip: '192.168.0.5', ports: [554] }]; } });
    try {
        const first = app.call('POST', '/api/finder/scan', {});
        await new Promise(r => setTimeout(r, 50));
        const second = await app.call('POST', '/api/finder/scan', {});
        assert.equal(second.status, 409);
        release();
        const res = await first;
        assert.equal(res.status, 200);
        assert.deepEqual((await res.json()).cameras, [{ ip: '192.168.0.5', ports: [554] }]);
    } finally { await app.close(); }
});

test('cameras: 이름과 호스트만 돌려주고 비밀번호는 노출하지 않는다', async () => {
    const app = await startApp();
    try {
        const res = await app.call('GET', '/api/finder/cameras');
        const text = await res.text();
        assert.ok(!text.includes('secret'));
        assert.deepEqual(JSON.parse(text).cameras, [{ index: 0, name: '거실', host: '192.168.0.5' }]);
    } finally { await app.close(); }
});

test('save: append 는 cctv.txt 에 추가하고 restartRequired 를 알린다', async () => {
    const app = await startApp();
    try {
        const res = await app.call('POST', '/api/finder/save', { url: 'rtsp://admin:pw%241@192.168.0.9:554/live', name: '주방', mode: 'append' });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.restartRequired, true);
        assert.equal(body.index, 1);
        const cams = parseCameras(fs.readFileSync(app.cctvPath, 'utf8'));
        assert.deepEqual(cams[1], { index: 1, url: 'rtsp://admin:pw%241@192.168.0.9:554/live', name: '주방' });
        assert.ok(fs.existsSync(app.cctvPath + '.bak'));
    } finally { await app.close(); }
});

test('save: replace 는 지정한 카메라를 교체한다', async () => {
    const app = await startApp();
    try {
        const res = await app.call('POST', '/api/finder/save', { url: 'rtsp://a:b@192.168.0.9:554/z', name: '새 거실', mode: 'replace', replaceIndex: 0 });
        assert.equal(res.status, 200);
        const cams = parseCameras(fs.readFileSync(app.cctvPath, 'utf8'));
        assert.equal(cams.length, 1);
        assert.equal(cams[0].name, '새 거실');
    } finally { await app.close(); }
});

test('save: 공인 IP, rtsp 아님, 쉼표/공백 포함, 잘못된 mode/replaceIndex 는 400 이고 파일은 그대로', async () => {
    const app = await startApp();
    const before = fs.readFileSync(app.cctvPath, 'utf8');
    try {
        for (const body of [
            { url: 'rtsp://a:b@8.8.8.8:554/x', name: 'n' },
            { url: 'http://192.168.0.9/x', name: 'n' },
            { url: 'rtsp://a:b@192.168.0.9:554/x,evil', name: 'n' },
            { url: 'rtsp://a:b@192.168.0.9:554/x y', name: 'n' },
            { url: 'not a url', name: 'n' },
            { url: 'rtsp://a:b@192.168.0.9:554/x', name: 'n', mode: 'delete' },
            { url: 'rtsp://a:b@192.168.0.9:554/x', name: 'n', mode: 'replace', replaceIndex: 9 },
        ]) {
            const res = await app.call('POST', '/api/finder/save', body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        assert.equal(fs.readFileSync(app.cctvPath, 'utf8'), before);
    } finally { await app.close(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd C:\cctvgo\backend && node --test tests/routes.test.js`
Expected: FAIL (`Cannot find module '../finder/routes'`)

- [ ] **Step 3: 구현**

`backend/finder/routes.js`:

```js
'use strict';
const fs = require('fs');
const { isPrivateIPv4, AuthBudget, createRateLimiter, createLock } = require('./guard');
const { parseCameras, saveCameraLine } = require('./cctv-file');
const { loadSettings } = require('./paths');
const { scanNetwork } = require('./scan');
const { findStream } = require('./find-stream');

/**
 * 카메라 주소 찾기 API. 모든 라우트에 기존 authMiddleware(세션 로그인)를 적용한다.
 * 이 파일에서 요청 본문(비밀번호 포함)을 로그로 남기지 않는다.
 */

function registerFinderRoutes(app, { authMiddleware, baseDir, cctvPath, deps = {}, budget = new AuthBudget() }) {
    const doScan = deps.scanNetwork || scanNetwork;
    const doFind = deps.findStream || findStream;

    const scanLock = createLock();
    const scanLimiter = createRateLimiter({ max: 6, windowMs: 60 * 1000 });
    const probeLimiter = createRateLimiter({ max: 20, windowMs: 60 * 1000 });
    const saveLimiter = createRateLimiter({ max: 20, windowMs: 60 * 1000 });

    const keyOf = req => req.sessionID || req.ip || 'anonymous';
    const bad = (res, message) => res.status(400).json({ status: 'error', message });
    const tooMany = res => res.status(429).json({ status: 'error', message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });

    app.post('/api/finder/scan', authMiddleware, async (req, res) => {
        if (!scanLimiter.allow(keyOf(req))) return tooMany(res);
        if (!scanLock.tryAcquire()) {
            return res.status(409).json({ status: 'error', message: '이미 검색 중입니다. 잠시 후 다시 시도하세요.' });
        }
        try {
            const cameras = await doScan();
            res.json({ status: 'success', cameras });
        } catch (error) {
            console.error('Finder scan failed:', error.message);
            res.status(500).json({ status: 'error', message: '네트워크 검색에 실패했습니다.' });
        } finally {
            scanLock.release();
        }
    });

    app.post('/api/finder/probe', authMiddleware, async (req, res) => {
        if (!probeLimiter.allow(keyOf(req))) return tooMany(res);
        const { ip, port, username, password, path, vendorHint } = req.body || {};

        if (!isPrivateIPv4(ip)) return bad(res, '사설 IP 주소(예: 192.168.0.10)만 입력할 수 있습니다.');
        let portNumber;
        if (port !== undefined && port !== null && port !== '') {
            portNumber = Number(port);
            if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return bad(res, '포트 번호가 올바르지 않습니다.');
        }
        for (const [label, v] of [['아이디', username], ['비밀번호', password], ['제조사 정보', vendorHint]]) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200)) return bad(res, `${label} 형식이 올바르지 않습니다.`);
        }
        let normalizedPath;
        if (path !== undefined && path !== null && path !== '') {
            if (typeof path !== 'string' || path.length > 300 || /\s/.test(path)) return bad(res, '경로 형식이 올바르지 않습니다.');
            normalizedPath = path.startsWith('/') ? path : '/' + path;
        }

        try {
            const result = await doFind({
                host: ip,
                port: portNumber,
                path: normalizedPath,
                username: username || '',
                password: password || '',
                vendorHint: vendorHint || '',
                budget,
                settings: deps.loadSettings ? deps.loadSettings() : loadSettings(baseDir),
            });
            res.json(result);
        } catch (error) {
            console.error('Finder probe failed:', error.message);
            res.status(500).json({ status: 'error', message: '주소 찾기 중 오류가 발생했습니다.' });
        }
    });

    app.get('/api/finder/cameras', authMiddleware, (req, res) => {
        try {
            const text = fs.existsSync(cctvPath) ? fs.readFileSync(cctvPath, 'utf8') : '';
            const cameras = parseCameras(text).map(c => {
                let host = '';
                try { host = new URL(c.url).hostname; } catch (e) { /* 주소 형식 오류는 빈 값 */ }
                return { index: c.index, name: c.name, host };
            });
            res.json({ status: 'success', cameras });
        } catch (error) {
            console.error('Finder cameras failed:', error.message);
            res.status(500).json({ status: 'error', message: 'cctv.txt 를 읽을 수 없습니다.' });
        }
    });

    app.post('/api/finder/save', authMiddleware, (req, res) => {
        if (!saveLimiter.allow(keyOf(req))) return tooMany(res);
        const { url, name, mode = 'append', replaceIndex } = req.body || {};

        if (typeof url !== 'string' || url.length > 500) return bad(res, '카메라 주소가 올바르지 않습니다.');
        if (/[\s,]/.test(url)) return bad(res, '카메라 주소에 공백이나 쉼표(,)를 넣을 수 없습니다.');
        let parsed;
        try { parsed = new URL(url); } catch (e) { return bad(res, '카메라 주소가 올바르지 않습니다.'); }
        if (parsed.protocol !== 'rtsp:' || !isPrivateIPv4(parsed.hostname)) return bad(res, 'rtsp:// 로 시작하는 사설 IP 주소만 저장할 수 있습니다.');
        if (mode !== 'append' && mode !== 'replace') return bad(res, '저장 방식이 올바르지 않습니다.');
        if (mode === 'replace' && !Number.isInteger(replaceIndex)) return bad(res, '교체할 카메라를 선택하세요.');

        try {
            const result = saveCameraLine(cctvPath, { url, name: typeof name === 'string' ? name : '', mode, replaceIndex });
            console.log(`[FINDER] cctv.txt 저장 완료 (mode=${mode}, index=${result.index})`);
            res.json({ status: 'success', restartRequired: true, index: result.index, backup: result.backup });
        } catch (error) {
            if (/교체할 카메라/.test(error.message)) return bad(res, error.message);
            console.error('Finder save failed:', error.message);
            res.status(500).json({ status: 'error', message: 'cctv.txt 저장에 실패했습니다.' });
        }
    });
}

module.exports = { registerFinderRoutes };
```

- [ ] **Step 4: server.js 에 등록**

`backend/server.js`의 `get-channel-list` 라우트(`app.get('/api/get-channel-list', ...)` 블록) 바로 아래, `// 인증 미들웨어` 주석 위에 추가한다. (`authMiddleware`는 함수 선언이라 호이스팅되고, 정적 파일/SPA fallback 미들웨어보다 앞에 등록되어야 한다.)

```js
// 카메라 주소 찾기 (RTSP Finder) API
const { registerFinderRoutes } = require('./finder/routes');
registerFinderRoutes(app, { authMiddleware, baseDir: BASE_DIR, cctvPath: CCTV_CONFIG_PATH });
```

- [ ] **Step 5: 통과 확인**

Run: `cd C:\cctvgo\backend && npm test`
Expected: 모든 테스트 PASS (routes 9개 포함)

- [ ] **Step 6: 서버 수동 확인 (로그인 필요 API)**

`backend/.env`가 없으면 임시로 만든다(git 제외 파일): `echo SESSION_SECRET=dev-secret> backend/.env`

```bash
cd /c/cctvgo/backend && node server.js
```

다른 터미널에서:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8085/api/finder/probe -H "Content-Type: application/json" -d "{}"
curl -s -c /tmp/jar -o /dev/null -d "password=1234" localhost:8085/login
curl -s -b /tmp/jar -X POST localhost:8085/api/finder/probe -H "Content-Type: application/json" -d "{\"ip\":\"8.8.8.8\"}"
curl -s -b /tmp/jar localhost:8085/api/finder/cameras
```

Expected: 첫 줄 `302`(로그인 리다이렉트), 두 번째는 `{"status":"error","message":"사설 IP 주소(예: 192.168.0.10)만 입력할 수 있습니다."}`, 세 번째는 `cctv.txt`의 카메라 이름/호스트 목록(비밀번호 없음). 확인 후 서버를 종료한다.

- [ ] **Step 7: 커밋**

```bash
cd /c/cctvgo && git add backend/finder/routes.js backend/server.js backend/tests/routes.test.js
git commit -m "카메라 찾기: /api/finder 라우트(scan, probe, cameras, save) 연결" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: 프론트엔드 화면 (/finder) + 진입 버튼

**Files:**
- Create: `frontend/src/views/CameraFinder.vue`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/views/LiveCctv.vue` (진입 링크 1개 + 스타일)

**Interfaces:**
- Consumes: Task 8의 4개 API (`/api/finder/scan`, `/probe`, `/cameras`, `/save`), 응답 형식은 계약 참조
- Produces: 라우트 `/finder`

프론트엔드에는 테스트 프레임워크가 없으므로 빌드와 수동 확인(Step 5~6)으로 검증한다.

- [ ] **Step 1: 라우트 추가**

`frontend/src/router/index.js`:

```js
import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import LiveCctv from '../views/LiveCctv.vue'
import CameraFinder from '../views/CameraFinder.vue'

const routes = [
  { path: '/login', component: LoginView },
  { path: '/', component: LiveCctv },
  { path: '/finder', component: CameraFinder }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
```

- [ ] **Step 2: CameraFinder.vue 작성**

`frontend/src/views/CameraFinder.vue`:

```vue
<template>
  <div class="finder">
    <header class="finder-head">
      <router-link to="/" class="back">← 영상 화면으로</router-link>
      <h2>카메라 주소 찾기</h2>
    </header>

    <!-- 1. 카메라 선택 -->
    <section v-if="step === 'select'" class="card">
      <p class="desc">같은 네트워크(공유기)에 연결된 카메라를 찾습니다. 카메라의 아이디/비밀번호는 직접 입력해야 합니다.</p>
      <button class="primary" :disabled="scanning" @click="runScan">
        {{ scanning ? '찾는 중... (최대 20초)' : '내 네트워크에서 카메라 찾기' }}
      </button>
      <p v-if="scanError" class="error">{{ scanError }}</p>

      <ul v-if="scanned" class="camera-list">
        <li v-for="c in cameras" :key="c.ip">
          <button class="list-item" @click="pickCamera(c)">
            <strong>{{ c.ip }}</strong>
            <span v-if="c.vendor || c.model" class="tag">{{ [c.vendor, c.model].filter(Boolean).join(' ') }}</span>
            <span v-if="c.ports.length" class="muted">포트 {{ c.ports.join(', ') }}</span>
          </button>
        </li>
      </ul>
      <p v-if="scanned && cameras.length === 0" class="muted">찾은 카메라가 없습니다. 아래에 IP 주소를 직접 입력하세요.</p>

      <div class="manual-ip">
        <label>IP 주소 직접 입력</label>
        <div class="row">
          <input v-model.trim="ip" placeholder="예: 192.168.0.10" inputmode="decimal" />
          <button :disabled="!ip" @click="goCredentials">다음</button>
        </div>
      </div>
    </section>

    <!-- 2. 아이디/비밀번호 -->
    <section v-else-if="step === 'credentials'" class="card">
      <p class="desc"><strong>{{ ip }}</strong><span v-if="vendorHint" class="tag">{{ vendorHint }}</span></p>
      <label>카메라 아이디</label>
      <input v-model.trim="username" autocomplete="off" />
      <label>카메라 비밀번호</label>
      <input v-model="password" type="password" autocomplete="off" @keyup.enter="runProbe(false)" />
      <p class="notice">카메라 잠금 방지를 위해 로그인 실패는 카메라당 최대 2회까지만 시도합니다. 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하세요.</p>
      <div class="row">
        <button @click="reset">처음으로</button>
        <button class="primary" :disabled="!username" @click="runProbe(false)">주소 찾기</button>
      </div>
    </section>

    <!-- 3. 탐색 중 -->
    <section v-else-if="step === 'probing'" class="card center">
      <div class="spinner"></div>
      <p>카메라 주소를 찾는 중입니다... (최대 1분)</p>
    </section>

    <!-- 4. 결과: 찾음 -->
    <section v-else-if="step === 'result'" class="card">
      <p class="ok">카메라 주소를 찾았습니다.</p>
      <div v-if="result.candidates.length > 1" class="candidates">
        <label v-for="(c, i) in result.candidates" :key="c.url" class="radio">
          <input type="radio" v-model="selected" :value="i" />
          <span>{{ c.label || '스트림 ' + (i + 1) }}</span>
        </label>
      </div>
      <p class="url">{{ maskedUrl(result.candidates[selected].url) }}</p>

      <label>카메라 이름</label>
      <input v-model.trim="name" placeholder="예: 거실" maxlength="30" />

      <label>저장 방식</label>
      <select v-model="saveMode">
        <option value="append">새 카메라로 추가</option>
        <option v-for="c in existing" :key="c.index" :value="'replace:' + c.index">기존 "{{ c.name || c.host }}" 카메라 교체</option>
      </select>
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <div class="row">
        <button @click="reset">처음으로</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '저장 중...' : 'cctv.txt에 저장' }}</button>
      </div>
    </section>

    <!-- 5. 결과: 못 찾음 -->
    <section v-else-if="step === 'failed'" class="card">
      <p class="error">{{ failMessage }}</p>
      <div class="row wrap">
        <button @click="step = 'credentials'">아이디/비밀번호 다시 입력</button>
        <button @click="step = 'manual'">주소 직접 입력</button>
        <button @click="reset">처음으로</button>
      </div>
      <div v-if="result && result.diagnostics" class="diag">
        <label>진단 정보 (문의 시 함께 보내 주세요. 비밀번호는 포함되지 않습니다)</label>
        <textarea ref="diagRef" readonly :value="result.diagnostics" rows="8" @focus="$event.target.select()"></textarea>
        <button @click="copyDiagnostics">{{ copied ? '복사됨' : '진단 정보 복사' }}</button>
      </div>
    </section>

    <!-- 6. 직접 입력 + 접속 테스트 -->
    <section v-else-if="step === 'manual'" class="card">
      <p class="desc">카메라 설명서에 있는 RTSP 주소의 포트와 경로를 입력하고 접속을 테스트합니다.</p>
      <p class="muted">예) rtsp://아이디:비밀번호@{{ ip }}:<b>554</b><b>/stream1</b></p>
      <label>포트</label>
      <input v-model.trim="port" placeholder="554" inputmode="numeric" />
      <label>경로</label>
      <input v-model.trim="path" placeholder="/stream1" />
      <p class="notice">접속 테스트에서 로그인이 실패하면 카메라 잠금 방지를 위해 실패 횟수에 합산됩니다.</p>
      <div class="row">
        <button @click="step = 'failed'">뒤로</button>
        <button class="primary" :disabled="!path" @click="runProbe(true)">접속 테스트</button>
      </div>
    </section>

    <!-- 7. 저장 완료 -->
    <section v-else-if="step === 'saved'" class="card center">
      <p class="ok">cctv.txt에 저장했습니다.</p>
      <p class="notice">변경 내용을 적용하려면 <strong>cctvgo.bat 창을 닫고 다시 실행</strong>하세요.</p>
      <div class="row">
        <button @click="reset">카메라 더 찾기</button>
        <router-link to="/" class="btn">영상 화면으로</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

// --- 상태 ---
const step = ref('select');   // select | credentials | probing | result | failed | manual | saved
const cameras = ref([]);
const scanning = ref(false);
const scanned = ref(false);
const scanError = ref('');

const ip = ref('');
const port = ref('');
const path = ref('');
const vendorHint = ref('');
const username = ref('admin');
const password = ref('');

const result = ref(null);
const failMessage = ref('');
const selected = ref(0);
const name = ref('');
const existing = ref([]);
const saveMode = ref('append');
const saving = ref(false);
const saveError = ref('');
const copied = ref(false);
const diagRef = ref(null);

// --- API ---
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = res.headers.get('content-type') || '';
  if (res.redirected || !type.includes('application/json')) {
    router.push('/login');   // 세션 만료: authMiddleware 가 /login 으로 리다이렉트한 경우
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `요청에 실패했습니다. (${res.status})`);
  return data;
}

// --- 동작 ---
async function runScan() {
  scanning.value = true;
  scanError.value = '';
  try {
    const data = await api('/api/finder/scan', { method: 'POST', body: '{}' });
    cameras.value = data.cameras;
    scanned.value = true;
  } catch (e) {
    scanError.value = e.message;
  } finally {
    scanning.value = false;
  }
}

function pickCamera(c) {
  ip.value = c.ip;
  port.value = c.ports.length ? String(c.ports[0]) : '';
  vendorHint.value = [c.vendor, c.model].filter(Boolean).join(' ');
  step.value = 'credentials';
}

function goCredentials() {
  vendorHint.value = '';
  step.value = 'credentials';
}

async function runProbe(manual) {
  step.value = 'probing';
  try {
    const body = {
      ip: ip.value,
      username: username.value,
      password: password.value,
      vendorHint: vendorHint.value,
    };
    if (manual) {
      body.path = path.value;
      if (port.value) body.port = port.value;
    }
    result.value = await api('/api/finder/probe', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (step.value === 'probing') {
      failMessage.value = e.message;
      result.value = null;
      step.value = 'failed';
    }
    return;
  }

  if (result.value.status === 'found') {
    selected.value = 0;
    saveMode.value = 'append';
    saveError.value = '';
    try {
      existing.value = (await api('/api/finder/cameras')).cameras;
    } catch (e) {
      existing.value = [];
    }
    step.value = 'result';
  } else {
    failMessage.value = messageFor(result.value);
    step.value = 'failed';
  }
}

function messageFor(r) {
  const vendor = vendorHint.value ? ` (감지된 제조사: ${vendorHint.value})` : '';
  switch (r.status) {
    case 'unreachable':
      return '카메라에 연결할 수 없습니다. IP 주소가 맞는지, 카메라 전원과 네트워크 연결을 확인하세요.';
    case 'auth_failed':
      return r.ambiguous
        ? `아이디/비밀번호 또는 경로 문제일 수 있습니다.${vendor} 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하고, 안 되면 "주소 직접 입력"을 사용하세요.`
        : '카메라 아이디 또는 비밀번호가 맞지 않습니다. 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하세요.';
    case 'auth_locked': {
      const min = Math.max(1, Math.ceil((r.retryAfterSec || 0) / 60));
      return `카메라 잠금 방지를 위해 약 ${min}분 뒤에 다시 시도하세요. 그 사이 카메라 자체 웹페이지에서 아이디/비밀번호를 확인해 보세요.`;
    }
    case 'path_not_found':
      return `카메라는 응답했지만 영상 주소를 찾지 못했습니다.${vendor} 카메라 설명서의 RTSP 주소를 확인해 "주소 직접 입력"을 사용하세요.`;
    default:
      return '주소를 찾지 못했습니다.';
  }
}

// 화면에는 비밀번호를 가린 주소를 보여 준다
function maskedUrl(url) {
  return url.replace(/^(rtsp:\/\/[^:@/]*):[^@]*@/, '$1:****@');
}

async function save() {
  saving.value = true;
  saveError.value = '';
  try {
    const body = { url: result.value.candidates[selected.value].url, name: name.value };
    if (saveMode.value.startsWith('replace:')) {
      body.mode = 'replace';
      body.replaceIndex = Number(saveMode.value.split(':')[1]);
    } else {
      body.mode = 'append';
    }
    await api('/api/finder/save', { method: 'POST', body: JSON.stringify(body) });
    step.value = 'saved';
  } catch (e) {
    saveError.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function copyDiagnostics() {
  const text = result.value?.diagnostics || '';
  try {
    await navigator.clipboard.writeText(text);   // http(LAN) 주소에서는 사용할 수 없을 수 있다
  } catch (e) {
    if (diagRef.value) {
      diagRef.value.focus();
      diagRef.value.select();
      document.execCommand('copy');
    }
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

function reset() {
  step.value = 'select';
  password.value = '';
  path.value = '';
  port.value = '';
  result.value = null;
  name.value = '';
}
</script>

<style scoped>
.finder { max-width: 560px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
.finder-head { margin-bottom: 12px; }
.finder-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.card.center { align-items: center; text-align: center; }
label { font-size: 13px; font-weight: 600; margin-top: 4px; }
input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 15px; border: 1px solid #bbb; border-radius: 6px; }
textarea { font-family: monospace; font-size: 12px; }
button, .btn { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary { background: #007bff; border-color: #007bff; color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; }
.row.wrap { flex-wrap: wrap; }
.camera-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list-item { width: 100%; text-align: left; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tag { background: #e8f1ff; color: #0056b3; border-radius: 4px; padding: 1px 6px; font-size: 12px; margin-left: 6px; }
.muted { color: #777; font-size: 13px; }
.desc { margin: 0 0 4px; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 4px 0; word-break: keep-all; }
.ok { color: #2e7d32; font-weight: 700; margin: 0; }
.url { font-family: monospace; background: #f3f3f3; padding: 6px 8px; border-radius: 6px; word-break: break-all; }
.radio { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.radio input { width: auto; }
.manual-ip { margin-top: 12px; border-top: 1px solid #eee; padding-top: 12px; }
.diag { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.spinner { width: 32px; height: 32px; border: 4px solid #ddd; border-top-color: #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 3: LiveCctv.vue 에 진입 링크 추가**

`frontend/src/views/LiveCctv.vue`에서 `<h2>실시간 CCTV 스트리밍</h2>` 바로 아래에 한 줄을 추가한다.

```html
    <h2>실시간 CCTV 스트리밍</h2>
    <router-link to="/finder" class="finder-link">카메라 주소 찾기</router-link>
```

같은 파일 `<style scoped>`의 `.page-wrapper` 규칙에 `position: relative;`를 추가하고, `h2` 규칙 아래에 스타일을 추가한다.

```css
.page-wrapper {
  position: relative;
  /* ...기존 속성 유지 */
}

.finder-link {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 10;
  padding: 4px 10px;
  font-size: 12px;
  color: #fff;
  background: rgba(0, 123, 255, 0.9);
  border-radius: 4px;
  text-decoration: none;
}
```

- [ ] **Step 4: 빌드 확인**

Run: `cd C:\cctvgo\frontend && npm install && npm run build`
Expected: 빌드 성공 (`dist/` 생성, 에러 없음)

- [ ] **Step 5: 카메라 없이 전체 흐름 확인 (mock 카메라 사용)**

`backend/tests/helpers/run-mock-camera.js`를 만든다 (개발용 수동 확인 스크립트, 테스트 아님):

```js
'use strict';
// 수동 확인용: 이 PC에서 가짜 RTSP 카메라를 554 포트로 띄운다. (Ctrl+C 로 종료)
// 카메라 주소 찾기 화면에서 아래 출력된 IP, 아이디 admin / 비밀번호 pw 로 찾아 본다.
const os = require('os');
const { createMockRtsp } = require('./mock-rtsp');

(async () => {
    const cam = await createMockRtsp({
        host: '0.0.0.0', port: 554,
        users: { admin: 'pw' }, validPaths: ['/Streaming/Channels/101'],
    });
    const ips = Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);
    console.log(`가짜 카메라 실행 중: 포트 ${cam.port}, IP 후보: ${ips.join(', ')}`);
    console.log('아이디: admin / 비밀번호: pw / 경로: /Streaming/Channels/101');
})();
```

실행 순서:

```bash
# 터미널 1: 가짜 카메라
cd /c/cctvgo/backend && node tests/helpers/run-mock-camera.js
# 터미널 2: 서버 (backend/.env 에 SESSION_SECRET 필요)
cd /c/cctvgo/backend && node server.js
```

브라우저에서 `http://localhost:8085` 로그인(기본 비밀번호 `1234`) 후 우측 상단 "카메라 주소 찾기"를 눌러 확인한다.

Expected:
1. "내 네트워크에서 카메라 찾기" → 목록에 이 PC의 IP가 포트 554로 표시된다.
2. 그 IP 선택 → admin / pw → "주소 찾기" → "카메라 주소를 찾았습니다" 와 `rtsp://admin:****@<IP>:554/Streaming/Channels/101` 표시.
3. 이름 입력 후 저장 → "cctv.txt에 저장했습니다" + 재시작 안내. `backend/cctv.txt` 끝에 새 줄이 추가되고 상단 주석이 보존되며 `backend/cctv.txt.bak`이 생긴다.
4. 비밀번호를 `wrong`으로 다시 시도 → "아이디 또는 비밀번호가 맞지 않습니다" 계열 안내, 2회 실패 후 다시 시도하면 "잠금 방지를 위해 약 30분 뒤" 안내.
5. 없는 IP(예: `192.168.219.250`) → "카메라에 연결할 수 없습니다".

확인이 끝나면 테스트 흔적을 되돌린다 (git 추적 파일만 복원, .bak 삭제).

```bash
cd /c/cctvgo && git checkout backend/cctv.txt && rm -f backend/cctv.txt.bak
```

- [ ] **Step 6: 커밋**

```bash
cd /c/cctvgo && git add frontend/src/views/CameraFinder.vue frontend/src/router/index.js frontend/src/views/LiveCctv.vue backend/tests/helpers/run-mock-camera.js
git commit -m "카메라 찾기: /finder 화면과 영상 화면 진입 링크" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9-2: `&` 포함 주소가 스트림 실행 스크립트까지 전달되는지 확인 (카메라 불필요, 필수)

Dahua 계열 주소(`/cam/realmonitor?channel=1&subtype=0`)는 이 기능이 저장할 수 있는 주소인데, 기존 `start_ffmpeg.bat` → `run_single_stream.bat` → ffmpeg 경로에서 `&`가 올바르게 전달되는지 확인된 적이 없다. `start_ffmpeg.bat`은 URL을 `^"!RTSP_URL!^"` 형태로 `cmd /c` 인자에 넘기는데, 따옴표 안의 `^`는 이스케이프가 아니라 문자 그대로라서 자식 `cmd`가 `&`를 명령 구분자로 해석해 주소가 잘릴 가능성이 있다. **이 작업은 통과(또는 수정 후 통과)해야 완료된다. 메모로 남기고 넘어가지 않는다. 통과하기 전에는 `feature/rtsp-finder`를 main에 병합하지 않는다.**

**Files:**
- Create: `backend/tests/helpers/amp-path-check.js` (수동 확인용 스크립트, 자동 테스트 아님)
- Modify (확인 결과가 FAIL일 때만): `start_ffmpeg.bat`, `run_single_stream.bat`
- Modify: `docs/superpowers/specs/2026-09-27-rtsp-finder-design.md` ("열린 항목"에 결과 기록)

**Interfaces:**
- Consumes: Task 4의 `createMockRtsp` (`backend/tests/helpers/mock-rtsp.js`)
- Produces: 스크립트 종료 코드 0(두 형식 모두 PASS) / 1(하나라도 FAIL)

- [ ] **Step 1: 확인 스크립트 작성**

`backend/tests/helpers/amp-path-check.js`:

```js
'use strict';
// & 가 들어간 RTSP 주소가 start_ffmpeg.bat -> run_single_stream.bat -> ffmpeg 까지 온전히 전달되는지 확인한다.
// 사용: node tests/helpers/amp-path-check.js [대기 ms, 기본 15000]
// 가짜 카메라(127.0.0.1:5540)가 받은 요청 경로를 보고 판정하고, 종료 코드 0=PASS, 1=FAIL.
const { createMockRtsp } = require('./mock-rtsp');

const WAIT_MS = Number(process.argv[2] || 15000);
const PLAIN = '/Streaming/Channels/101';
const AMP = '/cam/realmonitor?channel=1&subtype=0';

(async () => {
    const cam = await createMockRtsp({ requireAuth: false, port: 5540, validPaths: [PLAIN, AMP] });
    console.log(`가짜 카메라 대기 중 (포트 ${cam.port}, ${WAIT_MS / 1000}초)`);
    await new Promise(resolve => setTimeout(resolve, WAIT_MS));

    const paths = Array.from(new Set(cam.state.requests.map(r => r.path)));
    console.log('받은 요청 경로:', paths);
    const okPlain = paths.includes(PLAIN);
    const okAmp = paths.includes(AMP);
    console.log(`기존 형식(& 없음): ${okPlain ? 'PASS' : 'FAIL'}`);
    console.log(`& 포함 형식     : ${okAmp ? 'PASS' : 'FAIL'}`);
    await cam.close();
    process.exit(okPlain && okAmp ? 0 : 1);
})();
```

- [ ] **Step 2: 임시 패키지 폴더 구성 (PowerShell)**

운영 중인 `cctvgo.bat`이 있으면 영향을 주지 않도록, 저장소 폴더가 아니라 임시 폴더에 실제 스크립트를 복사해서 실행한다.

```powershell
$pkg = "$env:TEMP\cctvgo-amp-check"
Remove-Item -Recurse -Force $pkg -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$pkg\ffmpeg\bin", "$pkg\logs" | Out-Null
Copy-Item C:\cctvgo\start_ffmpeg.bat, C:\cctvgo\run_single_stream.bat $pkg
Copy-Item C:\cctvgo\ffmpeg\bin\cctvgo-ffmpeg.exe "$pkg\ffmpeg\bin\"
@"
rtsp://admin:start%244962@127.0.0.1:5540/Streaming/Channels/101, plain
rtsp://admin:pw%241@127.0.0.1:5540/cam/realmonitor?channel=1&subtype=0, amp
"@ | Set-Content -Encoding ascii "$pkg\cctv.txt"
Get-Content "$pkg\cctv.txt"
```

Expected: 두 줄이 그대로 출력된다 (2번째 줄에 `&` 포함).

- [ ] **Step 3: 가짜 카메라를 띄우고 실제 스크립트 실행**

```powershell
$pkg = "$env:TEMP\cctvgo-amp-check"
$mock = Start-Process node -ArgumentList 'tests/helpers/amp-path-check.js', '20000' -WorkingDirectory C:\cctvgo\backend -RedirectStandardOutput "$pkg\mock.out" -PassThru -WindowStyle Hidden
Start-Sleep 2
Start-Process cmd -ArgumentList '/c', 'start_ffmpeg.bat' -WorkingDirectory $pkg -WindowStyle Hidden
$mock.WaitForExit()
Get-Content "$pkg\mock.out"
"종료 코드: $($mock.ExitCode)"
Get-Content "$pkg\logs\stream_2.log" -TotalCount 15
```

Expected (통과): `기존 형식(& 없음): PASS`, `& 포함 형식     : PASS`, 종료 코드 0. 받은 요청 경로 목록에 `/cam/realmonitor?channel=1&subtype=0`가 통째로 있어야 한다.
FAIL이면 `stream_2.log`의 `RTSP_URL:` 줄이 어디서 잘렸는지(`channel=1`까지만 있는지 등)를 확인해 원인 위치(`start_ffmpeg.bat`의 인자 전달인지, `run_single_stream.bat`의 사용인지)를 기록한다.

- [ ] **Step 4: 실행한 프로세스 정리 (임시 폴더의 프로세스만)**

`cctvgo-ffmpeg.exe`를 이미지 이름으로 일괄 종료하면 운영 중인 스트림도 죽으므로, 반드시 임시 폴더 경로로 걸러서 종료한다.

```powershell
1..2 | ForEach-Object {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like '*cctvgo-amp-check*' -or $_.ExecutablePath -like '*cctvgo-amp-check*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cctvgo-amp-check*' } | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: 마지막 줄이 `0`.

- [ ] **Step 5: 결과에 따라 분기**

**PASS인 경우:** Step 6으로 간다.

**FAIL인 경우 (`&` 형식만 FAIL):** `superpowers:systematic-debugging`으로 원인을 확정한 뒤 수정한다. 후보 수정안(검증 전 가설): URL을 명령줄 인자가 아니라 환경 변수로 넘긴다. `start`로 띄운 자식 프로세스는 그 시점의 환경 변수를 물려받고, 환경 변수 값에 든 `&`는 명령으로 재해석되지 않는다.

- `start_ffmpeg.bat`: 루프 안에서 `start` 직전에 `set "STREAM_URL=!RTSP_URL!"` 를 실행하고, 자식 호출에서 `^"!RTSP_URL!^"` 인자를 제거한다 (나머지 3개 인자 `OUTPUT_DIR`, `STREAM_FILE`, `RETRY_DELAY`의 위치가 바뀌므로 `run_single_stream.bat`의 `%2`~`%4` 참조도 함께 맞춘다).
- `run_single_stream.bat`: `set "RTSP_URL=%1"` 대신 `set "RTSP_URL=!STREAM_URL!"` 를 사용한다.

수정 후 Step 2~4를 다시 실행해 **두 형식 모두 PASS**인지 확인한다. 기존 형식(`plain`)이 깨지면 안 된다. 가설이 틀려 PASS가 나오지 않으면 다른 수정안을 시도하고, 반복해도 안전하게 고칠 수 없으면 병합하지 말고 사용자에게 보고한다(이 주소를 저장 단계에서 경고/차단할지 결정 필요).

- [ ] **Step 6: 결과 기록 및 커밋**

스펙의 "열린 항목"에 다음을 추가한다 (실제 결과로 채운다).

```markdown
- `&` 포함 주소가 `start_ffmpeg.bat`/`run_single_stream.bat`을 통과하는지: 2026-MM-DD mock 카메라로 확인 — (PASS 그대로 통과 | FAIL 후 수정 X 적용, 재확인 PASS)
```

```bash
cd /c/cctvgo && git add backend/tests/helpers/amp-path-check.js docs/superpowers/specs/2026-09-27-rtsp-finder-design.md
# FAIL 후 수정한 경우에는 start_ffmpeg.bat run_single_stream.bat 도 함께 add
git commit -m "카메라 찾기: & 포함 주소의 스트림 스크립트 전달 확인" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: 집에서 실기 검증 (카메라 2대 필요, 코드 변경 없음)

카페에서는 진행하지 않는다. 집에서 카메라(`192.168.219.100` Hikvision 계열, `192.168.219.194` `/onvif1` 사용)에 접속 가능한 상태에서 수행하고, 결과를 스펙 `docs/superpowers/specs/2026-09-27-rtsp-finder-design.md`의 "열린 항목"에 기록한다.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-rtsp-finder-design.md` ("열린 항목" 결과 기록)

- [ ] **Step 1: 준비**

`cctvgo.bat`의 서비스가 8085 포트를 쓰고 있으면 종료한다. `cd C:\cctvgo\frontend && npm run build` 후 `cd C:\cctvgo\backend && node server.js` 실행, `http://localhost:8085` 로그인.
**주의:** 실기 검증 전에 `backend/cctv.txt`를 백업(`copy backend\cctv.txt backend\cctv.txt.manual-backup`)한다. 기능이 자동으로 `.bak`을 만들지만 별도로 보관한다.

- [ ] **Step 2: 스캔 확인**

"내 네트워크에서 카메라 찾기"로 두 카메라가 목록에 나오는지, 제조사/모델 힌트가 표시되는지 기록한다.
Expected: 두 IP가 포트 554와 함께 표시된다. (WS-Discovery 제조사 표시는 있으면 기록, 없어도 통과)

- [ ] **Step 3: 카메라별 ONVIF 응답 여부 확인**

서버 터미널이 아니라 화면 결과로 확인한다: 정상 계정으로 "주소 찾기"를 실행한 뒤, 실패했다면 "진단 정보 복사"의 `ONVIF:` 줄을, 성공했다면 후보 라벨(`main`/`sub` 등 프로파일 이름이 보이면 ONVIF 경로로 찾은 것)을 기록한다.
기록: 카메라 A = ONVIF 응답함/안 함, 카메라 B = ONVIF 응답함/안 함.
ONVIF가 두 카메라 모두 응답하지 않으면 스펙에 "ONVIF는 mock 테스트까지만 검증된 미검증 기능"이라고 명시한다.

- [ ] **Step 4: 정상 계정으로 URL 찾기**

각 카메라에서 올바른 아이디/비밀번호로 "주소 찾기".
Expected: 카메라 A → `/Streaming/Channels/101` (또는 ONVIF 후보), 카메라 B → `/onvif1` (또는 ONVIF 후보). 찾은 URL로 저장하고 `backend/cctv.txt`가 기존 카메라 줄(특수문자 `%24`, `%21` 포함)과 형식이 같은지 확인한다.

- [ ] **Step 5: "없는 경로에 404/401" 성향 확인**

Step 4 진행 중 진단 정보의 시도 목록 첫 `rtsp` 항목(`.../cctvgo-probe-test`)의 응답 코드를 기록한다. 404면 "잘못된 경로에 404를 주는 카메라", 401이면 "401을 주는 카메라"다. (진단 정보는 실패했을 때만 나오므로, 성공한 경우엔 서버 콘솔에서 확인할 수 없다. 이 항목은 존재하지 않는 경로로 "주소 직접 입력"을 한 번 실행해 `path_not_found`(=404)인지 `auth_failed` 안내(=401)인지로 확인한다. **틀린 경로로 직접 입력을 하면 401 성향 카메라에서는 실패 1회로 세어지므로 카메라당 1번만 한다.**)

- [ ] **Step 6: 잠금 방지 동작 확인 (틀린 비밀번호는 카메라당 최대 1번만)**

한 대에서만 틀린 비밀번호로 "주소 찾기"를 1번 실행해 예산 소진 안내가 나오는지 확인하고, 이후 올바른 비밀번호로 다시 시도했을 때 "잠금 방지" 안내가 나오는지 확인한다. **이 테스트는 카메라 계정 잠금을 일으킬 수 있으므로 반복하지 않는다.** 서버를 재시작하면 예산이 초기화된다.
Expected: 카메라가 본 로그인 실패는 2회 이하. 카메라 자체 웹페이지로 로그인이 여전히 되는지 확인한다.

- [ ] **Step 7: 스트림 반영 확인**

`cctvgo.bat`을 다시 실행해 저장한 카메라가 뷰어에 나오는지 확인한다.

- [ ] **Step 8: 정리 및 기록 커밋**

테스트로 바뀐 `backend/cctv.txt`를 원하는 최종 상태로 정리한다(변경을 남기지 않으려면 `git checkout backend/cctv.txt`, `.bak`/`.manual-backup` 삭제). 스펙의 "열린 항목"을 실제 결과로 갱신한다.

```bash
cd /c/cctvgo && git add docs/superpowers/specs/2026-09-27-rtsp-finder-design.md
git commit -m "RTSP Finder 실기 검증 결과 기록" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## 알려진 미검증 위험 (이번 범위 밖, 발견 시 별도 이슈)

- **URL에 `&`가 포함된 경우**(예: Dahua `/cam/realmonitor?channel=1&subtype=0`): 이 위험은 메모로 남기지 않고 **Task 9-2에서 반드시 확인/해결한다** (mock 카메라로 카메라 없이 검증 가능). Task 9-2가 통과하기 전에는 병합하지 않는다.
- ONVIF는 실기 검증이 카메라 2대로 제한된다 (Task 10 Step 3 결과에 따라 "미검증"으로 표시).
- 경로 후보 DB의 실제 커버리지 비율은 알 수 없다. 문의를 받으면 `rtsp-paths.json` 교체로 보강한다.
