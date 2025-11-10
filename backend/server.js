const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');
dotenv.config(); // .env 파일에서 환경 변수 로드

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

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HLS_DIR_PATH = path.join(__dirname, '..', 'hls');
const CCTV_CONFIG_PATH = path.join(__dirname, '..', 'cctv.txt');

/**
 * HLS 폴더 내의 하위 폴더(스트림) 개수를 세는 함수
 * fs.readdirSync를 사용하여 동기적으로 처리합니다.
 */
function countStreamFolders() {
    try {
        // 1. HLS 디렉토리의 모든 파일 및 폴더 목록을 읽습니다.
        const items = fs.readdirSync(HLS_DIR_PATH, { withFileTypes: true });

        // 2. 목록 중에서 디렉토리(폴더)만 필터링하고 개수를 셉니다.
        const folderCount = items.filter(item => item.isDirectory()).length;

        return { success: true, count: folderCount };
    } catch (error) {
        // 3. 디렉토리가 없거나 접근 권한 등의 오류가 발생했을 때 처리합니다.
        console.error('Error reading HLS directory:', error.message);
        // 에러 코드 500과 함께 에러 메시지를 반환합니다.
        return { success: false, error: 'Failed to read HLS stream directory.', details: error.message };
    }
}

/**
 * cctv.txt 파일에서 카메라 주소와 이름 목록을 읽어와 파싱하는 함수
 * @returns {object} { success: boolean, data: Array<string>, error?: string }
 */
function readCCTVConfig() {
    try {
        if (!fs.existsSync(CCTV_CONFIG_PATH)) {
            return { success: false, error: 'cctv.txt file not found.' };
        }

        const fileContent = fs.readFileSync(CCTV_CONFIG_PATH, 'utf8');
        const lines = fileContent.split('\n');
        const channelList = [];

        for (const line of lines) {
            const trimmedLine = line.trim();

            // 1. 주석 무시 (#으로 시작)
            if (trimmedLine.startsWith('#') || trimmedLine === '') {
                continue;
            }

            // 2. 콤마로 분리하여 이름 추출 (주소, 이름)
            const parts = trimmedLine.split(',');
            if (parts.length >= 2) {
                // 두 번째 요소(카메라 이름)를 트림하여 리스트에 추가
                const channelName = parts[1].trim();
                if (channelName) {
                    channelList.push(channelName);
                }
            }
        }

        return { success: true, data: channelList };
    } catch (error) {
        console.error('Error reading CCTV config file:', error.message);
        return { success: false, error: 'Failed to read and parse cctv.txt.', details: error.message };
    }
}

// 로그인 처리 API
app.post('/login', (req, res) => {
  if (!fs.existsSync(CONFIG_PATH)) return res.status(500).send('Config not found');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const inputPassword = req.body.password;
  if (inputPassword === config.password) {
    req.session.authenticated = true;
    return res.sendStatus(200);
  } else {
    return res.status(401).send('비밀번호가 틀렸습니다.');
  }
});

/**
 * 스트림 폴더 개수를 응답하는 API 엔드포인트
 * GET /api/get-camera-count
 */
app.get('/api/get-stream-count', (req, res) => {
    const result = countStreamFolders();

    if (result.success) {
        // 성공적으로 개수를 세었을 경우
        res.json({
            status: 'success',
            cameraCount: result.count,
            message: `Found ${result.count} stream folders in ${path.basename(HLS_DIR_PATH)}.`
        });
    } else {
        // 에러가 발생했을 경우 (예: 폴더를 찾지 못함)
        res.status(500).json({
            status: 'error',
            message: result.error,
            details: result.details
        });
    }
});

/**
 * 💡 cctv.txt 파일에서 카메라(채널) 이름 목록을 응답하는 API 엔드포인트
 * GET /api/get-channel-list
 */
app.get('/api/get-channel-list', authMiddleware, (req, res) => {
    const result = readCCTVConfig();

    if (result.success) {
        // 성공적으로 리스트를 읽었을 경우
        res.json({
            status: 'success',
            channelList: result.data,
            message: `Successfully read ${result.data.length} channels.`
        });
    } else {
        // 에러가 발생했을 경우
        res.status(500).json({
            status: 'error',
            message: result.error,
            details: result.details
        });
    }
});

// 인증 미들웨어
function authMiddleware(req, res, next) {
  // 로그인 페이지와 정적 자산은 인증 없이 접근 허용
  if (
    req.session.authenticated ||
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
app.use('/hls', authMiddleware, express.static(path.join(__dirname, '../hls')));

// 정적 파일 제공 - /login 경로는 제외하고 인증 미들웨어 적용
app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/login/')) {
    // /login 경로는 static 미들웨어로 처리하지 않고 넘어감 (Vue 라우터 처리)
    return next();
  }
  // /login 이외는 인증 후 정적 파일 제공
  authMiddleware(req, res, () => {
    express.static(path.join(__dirname, '../frontend/dist'))(req, res, next);
  });
});

// Vue 라우터 대응용 fallback - SPA 라우팅 처리
app.get('*', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
