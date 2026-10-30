'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createDiag, maskIp } = require('../diagnostics/diag');
const { registerDiagRoutes } = require('../diagnostics/routes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-diag-'));

test('maskIp: IPv4 는 앞 두 자리만, IPv6 는 앞 두 묶음만, 빈 값은 알 수 없음', () => {
    assert.equal(maskIp('211.36.147.187'), '211.36.x.x');
    assert.equal(maskIp('::ffff:192.168.0.7'), '192.168.x.x');
    assert.equal(maskIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:x');
    assert.equal(maskIp(''), '알 수 없음');
    assert.equal(maskIp(undefined), '알 수 없음');
});

test('connection: 한 줄 JSON 으로 남기고 IP 는 마스킹한다', () => {
    const dir = tmp();
    const d = createDiag({ logDir: dir, now: () => Date.UTC(2026, 9, 30, 1, 2, 3) });
    d.connection({ stage: 'signaling', k: 1, ok: true, variant: 'main', ip: '211.36.147.187', ua: 'UA' });
    const lines = fs.readFileSync(path.join(dir, 'connections.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.t, '2026-10-30T01:02:03.000Z');
    assert.equal(e.ip, '211.36.x.x');
    assert.equal(e.k, 1);
    assert.ok(!lines[0].includes('147.187'));
});

test('통계: 결과/원인/후보쌍별로 쌓이고 다시 시작해도 유지된다', () => {
    const dir = tmp();
    const d1 = createDiag({ logDir: dir });
    d1.connection({ stage: 'browser', k: 1, ok: true, pair: { local: 'srflx', remote: 'srflx' } });
    d1.connection({ stage: 'browser', k: 1, ok: false, reason: 'network' });
    d1.connection({ stage: 'signaling', k: 2, ok: false, reason: 'codec' });
    const d2 = createDiag({ logDir: dir });
    d2.connection({ stage: 'browser', k: 1, ok: false, reason: 'network' });
    const s = d2.summary();
    assert.equal(s.browser.ok, 1);
    assert.equal(s.browser.fail, 2);
    assert.equal(s.browser.reasons.network, 2);
    assert.equal(s.browser.pairs['srflx-srflx'], 1);
    assert.equal(s.signaling.reasons.codec, 1);
});

test('event: 운용 기록을 남긴다', () => {
    const dir = tmp();
    const d = createDiag({ logDir: dir });
    d.event('go2rtc-exit', { code: 1 });
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'cctvgo-events.log'), 'utf8').trim());
    assert.equal(e.kind, 'go2rtc-exit');
    assert.equal(e.code, 1);
});

test('text: 환경 점검, 최근 연결, 통계가 들어가고 카메라 주소/비밀번호는 없다', () => {
    const d = createDiag({ logDir: tmp(), version: '1.2.3' });
    d.env({ firewallRule: 'present', networkProfile: 'Public', publicIp: '14.4.x.x', publicIpClass: 'public', upnp: 'no-response' });
    d.event('encoder', { encoder: 'h264_qsv' });
    d.connection({ stage: 'browser', k: 3, ok: false, reason: 'network', url: 'rtsp://admin:secret@192.168.0.5/x' });
    const t = d.text();
    assert.match(t, /CCTVGO 진단 정보/);
    assert.match(t, /1\.2\.3/);
    assert.match(t, /Public/);
    assert.match(t, /h264_qsv/);
    assert.match(t, /network/);
    assert.ok(!t.includes('rtsp://'));
    assert.ok(!t.includes('secret'));
});

async function startApp() {
    const events = [];
    const diag = { connection: e => events.push(e), text: () => 'DIAG TEXT' };
    const app = express();
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerDiagRoutes(app, { authMiddleware, diag });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, body, auth = true) => fetch(base + url, {
        method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-auth': 'ok' } : {}), 'cf-connecting-ip': '211.36.147.187' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { call, events, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

test('report: 로그인하지 않으면 거절, 알 수 없는 필드는 버리고 값 형식을 검사한다', async () => {
    const app = await startApp();
    try {
        assert.equal((await app.call('POST', '/api/live/report', { k: 1 }, false)).status, 302);
        const res = await app.call('POST', '/api/live/report', {
            k: 2, outcome: 'failed', reason: 'network', variant: 'main', h265: false, ms: 15000,
            local: ['host/udp', 'srflx/udp', '<script>'], pair: { local: 'srflx', remote: 'prflx', protocol: 'udp' },
            evil: 'x', url: 'rtsp://a:b@c',
        });
        assert.equal(res.status, 204);
        const e = app.events[0];
        assert.equal(e.stage, 'browser');
        assert.equal(e.ok, false);
        assert.equal(e.k, 2);
        assert.deepEqual(e.local, ['host/udp', 'srflx/udp']);
        assert.deepEqual(e.pair, { local: 'srflx', remote: 'prflx', protocol: 'udp' });
        assert.equal(e.ip, '211.36.147.187');
        assert.equal(e.evil, undefined);
        assert.equal(e.url, undefined);
    } finally { await app.close(); }
});

test('report: 2KB 를 넘으면 413', async () => {
    const app = await startApp();
    try {
        const res = await app.call('POST', '/api/live/report', JSON.stringify({ k: 1, pad: 'x'.repeat(3000) }));
        assert.equal(res.status, 413);
        assert.equal(app.events.length, 0);
    } finally { await app.close(); }
});

test('diagnostics: 로그인 후 진단 텍스트를 준다', async () => {
    const app = await startApp();
    try {
        assert.equal((await app.call('GET', '/api/diagnostics', undefined, false)).status, 302);
        assert.deepEqual(await (await app.call('GET', '/api/diagnostics')).json(), { status: 'success', text: 'DIAG TEXT' });
    } finally { await app.close(); }
});
