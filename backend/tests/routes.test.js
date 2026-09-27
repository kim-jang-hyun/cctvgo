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

test('probe: 같은 IP 는 동시에 하나만 탐색하고, 다른 IP 는 허용하며, 끝나면 다시 가능', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const seen = [];
    const app = await startApp({
        findStream: async a => {
            seen.push(a.host);
            if (seen.length === 1) await gate;
            return { status: 'found', candidates: [], tried: [], diagnostics: '' };
        },
    });
    try {
        const first = app.call('POST', '/api/finder/probe', { ip: '192.168.0.5' });
        await new Promise(r => setTimeout(r, 50));
        const dup = await app.call('POST', '/api/finder/probe', { ip: '192.168.0.5' });
        assert.equal(dup.status, 409);
        assert.equal((await dup.json()).message, '같은 카메라에 대한 탐색이 이미 진행 중입니다. 잠시 후 다시 시도하세요.');
        const other = await app.call('POST', '/api/finder/probe', { ip: '192.168.0.6' });
        assert.equal(other.status, 200);
        release();
        assert.equal((await first).status, 200);
        const again = await app.call('POST', '/api/finder/probe', { ip: '192.168.0.5' });
        assert.equal(again.status, 200);
        assert.deepEqual(seen, ['192.168.0.5', '192.168.0.6', '192.168.0.5']);
    } finally { release(); await app.close(); }
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
