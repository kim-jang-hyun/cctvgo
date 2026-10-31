'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { registerFinderRoutes } = require('../finder/routes');
const { AuthBudget } = require('../finder/guard');

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
        for (const [m, u] of [['POST', '/api/finder/scan'], ['POST', '/api/finder/probe']]) {
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

test('probe: 아이디에 제어문자/따옴표가 있으면 400 이고 findStream 을 부르지 않는다', async () => {
    let called = 0;
    const app = await startApp({ findStream: async () => { called++; return { status: 'found' }; } });
    try {
        for (const username of ['ad"min', 'ad\r\nX: 1', 'a\x00b', 'a\x7fb', 'a\nb']) {
            const res = await app.call('POST', '/api/finder/probe', { ip: '192.168.0.5', username, password: 'pw' });
            assert.equal(res.status, 400, JSON.stringify(username));
        }
        assert.equal(called, 0);
    } finally { await app.close(); }
});

test('기본 budget 은 baseDir 의 finder-budget.json 에 영속화된다 (주입한 budget 이 우선)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-routes-'));
    const app = express();
    app.use(express.json());
    registerFinderRoutes(app, {
        authMiddleware: (req, res, next) => next(),
        baseDir: dir,
        cctvPath: path.join(dir, 'cctv.txt'),
        deps: { findStream: async a => { a.budget.recordFailure(a.host); return { status: 'auth_failed' }; } },
    });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/finder/probe`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: '192.168.0.5' }),
        });
        assert.equal(res.status, 200);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'finder-budget.json'), 'utf8'));
        assert.equal(saved['192.168.0.5'].count, 1);
        assert.ok(!JSON.stringify(saved).includes('pw'));
    } finally { await new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }); }
});

test('probe: skipOnvif 는 true 일 때만 넘긴다 (같은 비밀번호로 다시 시도)', async () => {
    const seen = [];
    const app = await startApp({ findStream: async a => { seen.push(a.skipOnvif); return { status: 'path_not_found', candidates: [], tried: [], diagnostics: '' }; } });
    try {
        for (const skipOnvif of [true, false, 'yes', undefined]) {
            await app.call('POST', '/api/finder/probe', { ip: '192.168.0.5', username: 'admin', password: 'pw', skipOnvif });
        }
        assert.deepEqual(seen, [true, false, false, false]);
    } finally { await app.close(); }
});
