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
