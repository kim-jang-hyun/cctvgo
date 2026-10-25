'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createPasswordStore } = require('../settings/password-store');
const { registerSettingsRoutes } = require('../settings/routes');

async function startApp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-settings-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ password: 'old-pass' }), 'utf8');
    const store = createPasswordStore(configPath);
    const session = { authenticated: true, passwordTag: store.tag() };

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session; next(); });
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerSettingsRoutes(app, { authMiddleware, store });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (body, auth = true) => fetch(base + '/api/settings/password', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-auth': 'ok' } : {}) },
        body: JSON.stringify(body),
    });
    return { call, store, session, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

test('로그인하지 않으면 authMiddleware 에 막힌다', async () => {
    const app = await startApp();
    try {
        const res = await app.call({ currentPassword: 'old-pass', newPassword: 'new-pass' }, false);
        assert.equal(res.status, 302);
        assert.equal(app.store.get(), 'old-pass');
    } finally { await app.close(); }
});

test('성공하면 비밀번호를 바꾸고, 요청한 세션은 새 태그로 로그인을 유지한다', async () => {
    const app = await startApp();
    try {
        const oldTag = app.store.tag();
        const res = await app.call({ currentPassword: 'old-pass', newPassword: 'new-pass' });
        assert.equal(res.status, 200);
        assert.equal(app.store.get(), 'new-pass');
        assert.notEqual(app.store.tag(), oldTag);          // 옛 태그를 가진 다른 세션은 authMiddleware 에서 막힌다
        assert.equal(app.session.passwordTag, app.store.tag());
    } finally { await app.close(); }
});

test('현재 비밀번호가 틀리면 401, 새 비밀번호가 규칙에 안 맞으면 400', async () => {
    const app = await startApp();
    try {
        let res = await app.call({ currentPassword: 'wrong', newPassword: 'new-pass' });
        assert.equal(res.status, 401);
        assert.match((await res.json()).message, /현재 비밀번호/);
        res = await app.call({ currentPassword: 'old-pass', newPassword: 'ab' });
        assert.equal(res.status, 400);
        assert.equal(app.store.get(), 'old-pass');
    } finally { await app.close(); }
});

test('현재 비밀번호를 계속 틀리면 429 로 막는다', async () => {
    const app = await startApp();
    try {
        let last;
        for (let i = 0; i < 6; i++) last = await app.call({ currentPassword: 'wrong' + i, newPassword: 'new-pass' });
        assert.equal(last.status, 429);
        const res = await app.call({ currentPassword: 'old-pass', newPassword: 'new-pass' });
        assert.equal(res.status, 429);
        assert.equal(app.store.get(), 'old-pass');
    } finally { await app.close(); }
});
