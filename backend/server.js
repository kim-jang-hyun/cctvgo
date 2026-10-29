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

console.log = (...args) => {
    originalLog(getTimestamp() + (args[0]?.toString().startsWith('[') ? '' : ' ') + args.join(' '));
};

console.error = (...args) => {
    originalError(getTimestamp() + " [ERROR] " + args.join(' '));
};
// --- 타임스탬프 로그 설정 끝 ---

const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { createPasswordStore } = require('./settings/password-store');

let BASE_DIR;
let HLS_STATIC_PATH;
let FRONTEND_DIST_STATIC_PATH;

if (process.pkg) {
    // process.pkg가 존재하면 -> PKG로 빌드된 실행 파일 환경
    // 실행 파일이 위치한 디렉토리 (예: C:\cctvgo\package)
    const EXEC_PATH = path.dirname(process.execPath);
    BASE_DIR = EXEC_PATH;
    HLS_STATIC_PATH = path.join(BASE_DIR, 'hls');
    FRONTEND_DIST_STATIC_PATH = path.join(BASE_DIR, 'frontend/dist');

    console.log(`[INFO] PKG Environment Detected. Base Path: ${BASE_DIR}`);
    console.log(`[HLS PATH] PKG 환경: ${HLS_STATIC_PATH}`);
    console.log(`[FRONTEND_DIST_STATIC_PATH] PKG 환경: ${FRONTEND_DIST_STATIC_PATH}`);
} else {
    // process.pkg가 없으면 -> 개발 환경 (일반 Node 실행)
    // __dirname은 현재 server.js 파일이 있는 디렉토리 (C:\cctvgo\backend)
    BASE_DIR = __dirname;
    HLS_STATIC_PATH = path.join(BASE_DIR, '..', 'hls');
    FRONTEND_DIST_STATIC_PATH = path.join(BASE_DIR, '..', 'frontend/dist');

    console.log(`[INFO] Development Environment Detected. Base Path: ${BASE_DIR}`);
    console.log(`[HLS PATH] 개발 환경: ${HLS_STATIC_PATH}`);
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

// 카메라 영상(run_single_stream.bat → cctvgo-ffmpeg)은 서비스가 켜고 끈다.
// 배치 파일과 hls 폴더는 PKG 환경에서는 실행 파일 옆, 개발 환경에서는 저장소 루트에 있다
const STREAM_SCRIPT_DIR = path.dirname(HLS_STATIC_PATH);
const { StreamManager } = require('./streams/stream-manager');
const { parseCameras } = require('./finder/cctv-file');
const streams = new StreamManager({ scriptDir: STREAM_SCRIPT_DIR });

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


// HLS 정적 파일 제공 (인증 필요)
app.use('/hls', authMiddleware, express.static(HLS_STATIC_PATH));

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

app.listen(PORT, async () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  // cctv.txt 순서대로 카메라 영상을 켠다 (실패해도 웹 화면은 계속 동작)
  try {
    const text = fs.existsSync(CCTV_CONFIG_PATH) ? fs.readFileSync(CCTV_CONFIG_PATH, 'utf8') : '';
    await streams.startAll(parseCameras(text).map(c => c.url));
  } catch (error) {
    console.error('Stream start failed:', error.message);
  }
});
