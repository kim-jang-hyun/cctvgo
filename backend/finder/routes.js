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
    const probingIps = new Set(); // 같은 카메라를 동시에 두 번 탐색하면 인증 실패 예산을 넘길 수 있어 IP별로 하나만 허용
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
                budget,
                settings: deps.loadSettings ? deps.loadSettings() : loadSettings(baseDir),
            });
            res.json(result);
        } catch (error) {
            console.error('Finder probe failed:', error.message);
            res.status(500).json({ status: 'error', message: '주소 찾기 중 오류가 발생했습니다.' });
        } finally {
            probingIps.delete(ip);
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
