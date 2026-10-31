'use strict';
const { isPrivateIPv4, AuthBudget, createRateLimiter, createLock } = require('./guard');
const { parseRtspUrl } = require('./cctv-file');
const { registerCameraRoutes } = require('./camera-routes');
const { loadSettings } = require('./paths');
const { scanNetwork } = require('./scan');
const { findStream } = require('./find-stream');

/**
 * 카메라 주소 찾기 API. 모든 라우트에 기존 authMiddleware(세션 로그인)를 적용한다.
 * 이 파일에서 요청 본문(비밀번호 포함)을 로그로 남기지 않는다.
 */

/**
 * 로그인 실패 예산은 탐색 요청(버튼 한 번)마다 새로 만든다. 한 번의 탐색 안에서는 실패를 최대 2회까지만 보내
 * 틀린 비밀번호로 경로 후보 수십 개를 두드려 카메라가 잠기는 일을 막는다. 요청 사이의 30분 잠금은 없다
 * (2026-10-31 운영자 결정: 화면 경고로 사용자에게 맡김).
 */
function registerFinderRoutes(app, { authMiddleware, baseDir, cctvPath, streams, deps = {}, newBudget = () => new AuthBudget() }) {
    const doScan = deps.scanNetwork || scanNetwork;
    const doFind = deps.findStream || findStream;

    const scanLock = createLock();
    const scanLimiter = createRateLimiter({ max: 6, windowMs: 60 * 1000 });
    const probeLimiter = createRateLimiter({ max: 20, windowMs: 60 * 1000 });
    const probingIps = new Set(); // 같은 카메라를 동시에 두 번 탐색하면 인증 실패 예산을 넘길 수 있어 IP별로 하나만 허용
    const settings = () => (deps.loadSettings ? deps.loadSettings() : loadSettings(baseDir));

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
        const body = req.body || {};
        let { ip, port, username, password, path } = body;
        const { vendorHint } = body;
        // RTSP 주소 직접 입력: 주소를 나눠 쓰고, 따로 입력한 아이디/비밀번호가 있으면 그 값이 우선한다
        if (body.rtspUrl !== undefined) {
            const parts = typeof body.rtspUrl === 'string' && body.rtspUrl.length <= 500 ? parseRtspUrl(body.rtspUrl) : null;
            if (!parts) return bad(res, 'RTSP 주소 형식이 올바르지 않습니다.');
            ip = parts.host;
            port = parts.port;
            path = parts.path;
            if (!username) username = parts.username;
            if (!password) password = parts.password;
        }

        if (!isPrivateIPv4(ip)) return bad(res, '사설 IP 주소(예: 192.168.0.10)만 입력할 수 있습니다.');
        let portNumber;
        if (port !== undefined && port !== null && port !== '') {
            portNumber = Number(port);
            if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return bad(res, '포트 번호가 올바르지 않습니다.');
        }
        for (const [label, v] of [['아이디', username], ['비밀번호', password], ['제조사 정보', vendorHint]]) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200)) return bad(res, `${label} 형식이 올바르지 않습니다.`);
        }
        // 아이디는 RTSP Digest 헤더에 그대로 들어가므로 줄바꿈/따옴표/제어문자를 거부한다
        if (typeof username === 'string' && /[\x00-\x1f\x7f"]/.test(username)) return bad(res, '아이디에 사용할 수 없는 문자(따옴표, 줄바꿈 등)가 있습니다.');
        let normalizedPath;
        if (path !== undefined && path !== null && path !== '') {
            if (typeof path !== 'string' || path.length > 300 || /\s/.test(path)) return bad(res, '경로 형식이 올바르지 않습니다.');
            normalizedPath = path.startsWith('/') ? path : '/' + path;
        }

        if (probingIps.has(ip)) {
            return res.status(409).json({ status: 'error', message: '같은 카메라에 대한 탐색이 이미 진행 중입니다. 잠시 후 다시 시도하세요.' });
        }
        probingIps.add(ip);
        try {
            const result = await doFind({
                host: ip,
                port: portNumber,
                path: normalizedPath,
                username: username || '',
                password: password || '',
                vendorHint: vendorHint || '',
                budget: newBudget(),
                settings: settings(),
            });
            res.json(result);
        } catch (error) {
            console.error('Finder probe failed:', error.message);
            res.status(500).json({ status: 'error', message: '주소 찾기 중 오류가 발생했습니다.' });
        } finally {
            probingIps.delete(ip);
        }
    });

    // 카메라 관리 API 는 인증 실패 예산과 탐색 중 IP 목록을 probe 와 함께 쓴다 (같은 카메라 잠금 방지)
    registerCameraRoutes(app, { authMiddleware, cctvPath, streams, shared: { newBudget, probingIps, probeLimiter, doFind, settings, keyOf } });
}

module.exports = { registerFinderRoutes };
