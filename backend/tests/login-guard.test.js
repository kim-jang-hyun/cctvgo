'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginGuard, clientKey } = require('../settings/login-guard');

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: ms => { t += ms; } };
}

test('5번 틀리면 그 접속자만 15분 막고, 시간이 지나면 풀린다', () => {
    const c = clock();
    const guard = createLoginGuard({ now: c.now });
    for (let i = 0; i < 4; i++) {
        guard.recordFailure('a');
        assert.equal(guard.retryAfterMs('a'), 0);
    }
    guard.recordFailure('a');
    assert.equal(guard.retryAfterMs('a'), 15 * 60 * 1000);
    assert.equal(guard.retryAfterMs('b'), 0);          // 다른 접속자는 영향 없음
    c.advance(15 * 60 * 1000 - 1);
    assert.ok(guard.retryAfterMs('a') > 0);
    c.advance(1);
    assert.equal(guard.retryAfterMs('a'), 0);
});

test('맞히면 틀린 횟수를 지운다', () => {
    const guard = createLoginGuard({ now: clock().now });
    for (let i = 0; i < 4; i++) guard.recordFailure('a');
    guard.reset('a');
    guard.recordFailure('a');
    assert.equal(guard.retryAfterMs('a'), 0);
});

test('마지막 실패에서 15분이 지나면 횟수가 처음부터 다시 센다', () => {
    const c = clock();
    const guard = createLoginGuard({ now: c.now });
    for (let i = 0; i < 4; i++) guard.recordFailure('a');
    c.advance(15 * 60 * 1000);
    guard.recordFailure('a');
    assert.equal(guard.retryAfterMs('a'), 0);
});

test('오래된 기록은 지워져 메모리가 계속 늘지 않는다', () => {
    const c = clock();
    const guard = createLoginGuard({ now: c.now });
    for (let i = 0; i < 100; i++) guard.recordFailure('ip' + i);
    c.advance(15 * 60 * 1000);
    guard.recordFailure('new');
    assert.equal(guard.size(), 1);
});

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('cloudflared(같은 PC)에서 온 요청은 CF-Connecting-IP 로 접속자를 구분한다', () => {
    assert.equal(clientKey(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.5' })), '203.0.113.5');
    assert.equal(clientKey(req('::1', { 'cf-connecting-ip': '203.0.113.5' })), '203.0.113.5');
    assert.equal(clientKey(req('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.5' })), '203.0.113.5');
});

test('공유기 안에서 바로 온 요청은 머리글을 믿지 않고 실제 연결 주소를 쓴다', () => {
    assert.equal(clientKey(req('::ffff:192.168.0.20', { 'cf-connecting-ip': '203.0.113.5' })), '192.168.0.20');
    assert.equal(clientKey(req('192.168.0.20')), '192.168.0.20');
    assert.equal(clientKey(req('127.0.0.1')), '127.0.0.1');   // 서버 PC 에서 직접 접속
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createPasswordStore } = require('../settings/password-store');
const { registerLoginRoute } = require('../settings/login-guard');

async function startLoginApp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-login-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ password: 'right-pass' }), 'utf8');
    const store = createPasswordStore(configPath);
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    const sessions = [];
    app.use((req, res, next) => { req.session = {}; sessions.push(req.session); next(); });
    registerLoginRoute(app, { store });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    // 테스트 서버에는 127.0.0.1 로 붙으므로, cloudflared 처럼 CF-Connecting-IP 로 접속자를 바꿔 보낸다
    const login = (password, ip = '203.0.113.1') => fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
        body: new URLSearchParams({ password }),
    });
    return { login, sessions, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

test('로그인: 맞으면 200 과 세션 인증, 틀리면 401', async () => {
    const app = await startLoginApp();
    try {
        assert.equal((await app.login('wrong')).status, 401);
        const res = await app.login('right-pass');
        assert.equal(res.status, 200);
        assert.equal(app.sessions.at(-1).authenticated, true);
    } finally { await app.close(); }
});

test('로그인: 5번 틀리면 맞는 비밀번호도 429, 다른 접속자는 그대로 로그인된다', async () => {
    const app = await startLoginApp();
    try {
        for (let i = 0; i < 5; i++) assert.equal((await app.login('wrong' + i)).status, 401);
        const blocked = await app.login('right-pass');
        assert.equal(blocked.status, 429);
        assert.match(await blocked.text(), /15분 뒤에 다시 시도/);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
        assert.equal((await app.login('right-pass', '198.51.100.7')).status, 200);
    } finally { await app.close(); }
});
