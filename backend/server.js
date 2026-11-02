// --- 타임스탬프 로그 설정 시작 ---
const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0').substring(0, 2); // .20 형식
    return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}]`;
}

// logs 폴더가 정해지면 날짜별 파일(service-YYYY-MM-DD.log)에도 쓴다. 패키지(설치판)에서는 화면 출력 대신 이 파일에만 쓴다:
// cctvgo.bat 이 화면 출력을 파일 하나(service.log)로 받아 몇 달씩 이어 쓰면 지워지지 않고 계속 커지기 때문이다
// (예상 못한 오류로 서비스가 죽을 때의 출력은 그대로 service.log 에 남는다)
let serviceLogDir = null;
const { appendLog } = require('./diagnostics/log-files');
function writeServiceLog(print, line) {
    if (serviceLogDir) appendLog(serviceLogDir, 'service', line);
    if (!(serviceLogDir && process.pkg)) print(line);
}

console.log = (...args) => {
    writeServiceLog(originalLog, getTimestamp() + (args[0]?.toString().startsWith('[') ? '' : ' ') + args.join(' '));
};

console.error = (...args) => {
    writeServiceLog(originalError, getTimestamp() + " [ERROR] " + args.join(' '));
};
// --- 타임스탬프 로그 설정 끝 ---

const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { createPasswordStore } = require('./settings/password-store');

let BASE_DIR;
let INSTALL_DIR;   // go2rtc 폴더와 logs 폴더가 있는 곳
let FRONTEND_DIST_STATIC_PATH;

if (process.pkg) {
    // process.pkg가 존재하면 -> PKG로 빌드된 실행 파일 환경
    // 실행 파일이 위치한 디렉토리 (예: C:\cctvgo\package)
    const EXEC_PATH = path.dirname(process.execPath);
    BASE_DIR = EXEC_PATH;
    INSTALL_DIR = BASE_DIR;
    FRONTEND_DIST_STATIC_PATH = path.join(BASE_DIR, 'frontend/dist');

    console.log(`[INFO] PKG Environment Detected. Base Path: ${BASE_DIR}`);
    console.log(`[FRONTEND_DIST_STATIC_PATH] PKG 환경: ${FRONTEND_DIST_STATIC_PATH}`);
} else {
    // process.pkg가 없으면 -> 개발 환경 (일반 Node 실행)
    // __dirname은 현재 server.js 파일이 있는 디렉토리 (C:\cctvgo\backend)
    BASE_DIR = __dirname;
    INSTALL_DIR = path.join(BASE_DIR, '..');
    FRONTEND_DIST_STATIC_PATH = path.join(BASE_DIR, '..', 'frontend/dist');

    console.log(`[INFO] Development Environment Detected. Base Path: ${BASE_DIR}`);
    console.log(`[FRONTEND_DIST_STATIC_PATH] 개발 환경: ${FRONTEND_DIST_STATIC_PATH}`);
}

const dotenv = require('dotenv');
dotenv.config({ path: path.join(BASE_DIR, '.env') });   // .env 파일에서 환경 변수 로드

const app = express();
const PORT = 8085;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 1 }  // 1시간
}));

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const passwordStore = createPasswordStore(CONFIG_PATH);
const CCTV_CONFIG_PATH = path.join(BASE_DIR, 'cctv.txt');

// 카메라 영상은 서비스가 go2rtc(자식 프로세스)로 켜고 끈다. 영상은 go2rtc WebRTC 포트로 브라우저에 직접 간다.
// go2rtc 관리 API 는 127.0.0.1 에만 열고, 시작할 때마다 새로 만든 비밀번호로만 쓴다
const crypto = require('crypto');
const { StreamManager } = require('./streams/stream-manager');
const { Go2rtcApi } = require('./streams/go2rtc-api');
const { Go2rtcProcess } = require('./streams/go2rtc-process');
const { buildConfig, DEFAULT_PORTS } = require('./streams/go2rtc-config');
const { parseCameras } = require('./finder/cctv-file');
const { probeEncoders, encoderTemplate, transcodeSource, encoderList } = require('./streams/encoder-probe');
const LOG_DIR = path.join(INSTALL_DIR, 'logs');
serviceLogDir = LOG_DIR;
// 30일 지난 로그 정리: 시작할 때와 하루에 한 번 (몇 달씩 재시작 없이 켜 두는 PC 가 많다)
const { pruneLogs } = require('./diagnostics/log-files');
const pruneOldLogs = () => {
    const { deleted } = pruneLogs(LOG_DIR);
    if (deleted.length) console.log(`[LOGS] 오래된 로그 ${deleted.length}개 정리`);
};
pruneOldLogs();
setInterval(pruneOldLogs, 24 * 60 * 60 * 1000).unref();
// 연결 실패·운용 기록 (logs 폴더에만 남기고, 설정 화면의 "진단 정보 복사"로 문의 때 받는다)
const { createDiag } = require('./diagnostics/diag');
const { checkEnvironment } = require('./diagnostics/environment');
const { stunBinding } = require('./diagnostics/stun');
const diag = createDiag({ logDir: LOG_DIR, version: require('./package.json').version });
const GO2RTC_AUTH = { username: 'cctvgo', password: crypto.randomBytes(24).toString('hex') };
const go2rtcApi = new Go2rtcApi({ port: DEFAULT_PORTS.api, ...GO2RTC_AUTH });
const streams = new StreamManager({ api: go2rtcApi });
// go2rtc 설정: 시작 때와, go2rtc 가 죽었다 다시 뜰 때(그 사이 추가·수정·삭제한 카메라 반영) 같은 방식으로 만든다
const FFMPEG_PATH = path.join(INSTALL_DIR, 'ffmpeg', 'bin', 'cctvgo-ffmpeg.exe');
let selectedEncoder = null;
const makeGo2rtcConfig = () => buildConfig({
  apiPort: DEFAULT_PORTS.api, rtspPort: DEFAULT_PORTS.rtsp, webrtcPort: DEFAULT_PORTS.webrtc, ...GO2RTC_AUTH,
  streams: streams.currentStreams(),
  // 전체 경로 대신 이름만: go2rtc 가 공백에서 경로를 잘라서, 폴더는 아래 pathDirs 로 PATH 에 넣는다
  ffmpeg: selectedEncoder ? { bin: path.basename(FFMPEG_PATH), h264: encoderTemplate(selectedEncoder) } : null,
});
const go2rtc = new Go2rtcProcess({
  installDir: INSTALL_DIR, logDir: LOG_DIR, event: diag.event, makeConfig: makeGo2rtcConfig, pathDirs: [path.dirname(FFMPEG_PATH)], rtspPort: DEFAULT_PORTS.rtsp,
  // 다시 뜬 go2rtc 가 API 를 열 때까지 기다린 뒤 다시 넣는다 (바로 보내면 연결이 거부된다)
  onRestart: async () => { await go2rtcApi.waitReady(); await streams.resync(); },
});
// 서비스가 끝나면 go2rtc 도 끈다 (남겨 두면 다음 시작 때 포트가 겹친다)
process.on('exit', () => go2rtc.stop());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));

// 로그인 처리 API
app.post('/login', (req, res) => {
  const password = passwordStore.get();
  if (password === null) return res.status(500).send('Config not found');

  const inputPassword = req.body.password;
  if (inputPassword === password) {
    req.session.authenticated = true;
    req.session.passwordTag = passwordStore.tag();
    return res.sendStatus(200);
  } else {
    return res.status(401).send('비밀번호가 틀렸습니다.');
  }
});

// 카메라 주소 찾기 + 카메라 관리 API (영상 화면용 /api/get-channel-list 포함)
const { registerFinderRoutes } = require('./finder/routes');
registerFinderRoutes(app, { authMiddleware, baseDir: BASE_DIR, cctvPath: CCTV_CONFIG_PATH, streams });

// 영상 연결(WebRTC 시그널링) API
const { registerLiveRoutes } = require('./streams/live-routes');
registerLiveRoutes(app, { authMiddleware, streams, api: go2rtcApi, diag });
const { registerDiagRoutes } = require('./diagnostics/routes');
// 진단 파일(zip): 고객이 문의할 때 이 파일 하나만 보내면 되게 한다 (비밀번호는 넣지 않음)
const { buildBundle } = require('./diagnostics/bundle');
const SERVICE_STARTED_AT = new Date().toISOString();
registerDiagRoutes(app, {
  authMiddleware, diag,
  bundle: () => buildBundle({
    logDir: LOG_DIR, cctvPath: CCTV_CONFIG_PATH, diagText: () => diag.text(), go2rtcStreams: () => go2rtcApi.getStreams(),
    info: {
      'CCTVGO 버전': require('./package.json').version, '서비스 시작': SERVICE_STARTED_AT, 'H.265 변환기': selectedEncoder || '없음',
      '설치 폴더': INSTALL_DIR, 'Node': process.version, '카메라 번호 체계': streams.epoch,
    },
  }),
});

// 설정 화면 API (비밀번호 변경)
const { registerSettingsRoutes } = require('./settings/routes');
registerSettingsRoutes(app, { authMiddleware, store: passwordStore });

// 인증 미들웨어
function authMiddleware(req, res, next) {
  // 로그인 페이지와 정적 자산은 인증 없이 접근 허용
  // 비밀번호가 바뀌면 그 전에 로그인한 세션은 태그가 달라 로그아웃된다
  if (
    (req.session.authenticated && req.session.passwordTag === passwordStore.tag()) ||
    req.path === '/login' ||
    req.path.startsWith('/login/') ||
    req.path.startsWith('/assets') ||
    req.path.startsWith('/favicon.ico')
  ) {
    return next();
  }
  res.redirect('/login');
}


// 정적 파일 제공 - /login 경로는 제외하고 인증 미들웨어 적용
app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/login/')) {
    // /login 경로는 static 미들웨어로 처리하지 않고 넘어감 (Vue 라우터 처리)
    return next();
  }
  // /login 이외는 인증 후 정적 파일 제공
  authMiddleware(req, res, () => {
    express.static(FRONTEND_DIST_STATIC_PATH)(req, res, next);
  });
});

// Vue 라우터 대응용 fallback - SPA 라우팅 처리
app.get('*', authMiddleware, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIST_STATIC_PATH, 'index.html'));
});

/**
 * 영상 준비가 끝난 뒤에 요청을 받는다. 준비 중에 채널 목록을 받으면 모든 칸이 빈 칸이 되고,
 * 준비 중에 추가한 카메라는 go2rtc 에 들어가지 않기 때문이다. 영상 준비가 실패해도 웹 화면은 연다.
 */
async function startStreams() {
  try {
    // H.265 카메라를 PC 브라우저용 H.264 로 바꿀 변환기를 먼저 고른다 (go2rtc 설정에 넣어야 해서 go2rtc 시작 전에)
    // 변환본은 보는 사람이 있고 원본/서브가 코덱 때문에 안 될 때만 go2rtc 가 실행한다
    selectedEncoder = await probeEncoders({ ffmpegPath: FFMPEG_PATH, encoders: encoderList(process.env.CCTVGO_ENCODERS) }).catch(() => null);
    diag.event('encoder', { encoder: selectedEncoder || '없음' });
    console.log(`[STREAM] H.265 변환기: ${selectedEncoder || '없음 (PC 브라우저에서 H.265 카메라는 안내만 표시)'}`);
    if (selectedEncoder) streams.setTranscodeSource(transcodeSource);

    const text = fs.existsSync(CCTV_CONFIG_PATH) ? fs.readFileSync(CCTV_CONFIG_PATH, 'utf8') : '';
    streams.initialStreams(parseCameras(text));
    await go2rtc.start(makeGo2rtcConfig());
    if (!(await go2rtcApi.waitReady())) console.error('[GO2RTC] API 응답 없음 (영상이 나오지 않을 수 있음)');
  } catch (error) {
    console.error('Stream start failed:', error.message);
  }
}

startStreams().then(() => app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  // 환경 점검: 시작 후 한 번, 그 뒤 6시간마다 (실패해도 서비스에 영향 없음)
  const checkEnv = () => checkEnvironment({ installDir: INSTALL_DIR, stun: () => stunBinding() })
    .then(result => diag.env(result))
    .catch(error => console.error('Environment check failed:', error.message));
  checkEnv();
  setInterval(checkEnv, 6 * 60 * 60 * 1000).unref();
}));
