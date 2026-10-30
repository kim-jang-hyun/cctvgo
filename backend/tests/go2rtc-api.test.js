'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Go2rtcApi } = require('../streams/go2rtc-api');
const { getClosedPort } = require('./helpers/ports');

/** 요청을 기록하고 handler 로 응답하는 가짜 go2rtc */
async function fakeServer(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const r = { method: req.method, url: req.url, headers: req.headers, body };
            requests.push(r);
            handler(r, res);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, requests, close: () => new Promise(r => server.close(r)) };
}

const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');

test('putStream/deleteStream: PATCH 로 추가·갱신하고(설정 파일을 건드리지 않음) 이름과 주소를 인코딩해 보내며 Basic 인증을 붙인다', async () => {
    const s = await fakeServer((r, res) => res.end(''));
    try {
        const api = new Go2rtcApi({ port: s.port, username: 'u', password: 'p' });
        await api.putStream('s1', 'rtsp://a:b%21@192.168.0.5:554/x?c=1&d=2');
        await api.deleteStream('s1');
        assert.equal(s.requests[0].method, 'PATCH');
        const q = new URL(s.requests[0].url, 'http://x').searchParams;
        assert.equal(q.get('name'), 's1');
        assert.equal(q.get('src'), 'rtsp://a:b%21@192.168.0.5:554/x?c=1&d=2');
        assert.equal(s.requests[1].method, 'DELETE');
        assert.equal(new URL(s.requests[1].url, 'http://x').searchParams.get('src'), 's1');
        assert.ok(s.requests.every(r => r.headers.authorization === AUTH));
    } finally { await s.close(); }
});

test('putStream: go2rtc 가 실패를 돌려주면 reject 한다', async () => {
    const s = await fakeServer((r, res) => { res.statusCode = 500; res.end('bad'); });
    try {
        const api = new Go2rtcApi({ port: s.port, username: 'u', password: 'p' });
        await assert.rejects(api.putStream('s1', 'rtsp://x'));
    } finally { await s.close(); }
});

test('offer: application/sdp 로 보내고 201 이면 answer 를 돌려준다', async () => {
    const s = await fakeServer((r, res) => { res.statusCode = 201; res.setHeader('Content-Type', 'application/sdp'); res.end('v=0 answer'); });
    try {
        const api = new Go2rtcApi({ port: s.port, username: 'u', password: 'p' });
        const r = await api.offer('s2_sub', 'v=0 offer');
        assert.deepEqual(r, { ok: true, status: 201, body: 'v=0 answer' });
        assert.equal(s.requests[0].method, 'POST');
        assert.equal(new URL(s.requests[0].url, 'http://x').pathname, '/api/webrtc');
        assert.equal(new URL(s.requests[0].url, 'http://x').searchParams.get('src'), 's2_sub');
        assert.equal(s.requests[0].headers['content-type'], 'application/sdp');
        assert.equal(s.requests[0].body, 'v=0 offer');
        assert.equal(s.requests[0].headers.authorization, AUTH);
    } finally { await s.close(); }
});

test('offer: 500/404 는 예외 없이 ok:false 와 본문을 돌려준다', async () => {
    let code = 500;
    const s = await fakeServer((r, res) => { res.statusCode = code; res.end(code === 500 ? 'streams: codecs not matched' : ''); });
    try {
        const api = new Go2rtcApi({ port: s.port, username: 'u', password: 'p' });
        assert.deepEqual(await api.offer('s1', 'x'), { ok: false, status: 500, body: 'streams: codecs not matched' });
        code = 404;
        assert.deepEqual(await api.offer('s1', 'x'), { ok: false, status: 404, body: '' });
    } finally { await s.close(); }
});

test('offer: go2rtc 가 꺼져 있으면 status 0', async () => {
    const api = new Go2rtcApi({ port: await getClosedPort(), username: 'u', password: 'p' });
    const r = await api.offer('s1', 'x');
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
});

test('ping: 응답하면 true, 꺼져 있으면 false', async () => {
    const s = await fakeServer((r, res) => res.end('{}'));
    try {
        assert.equal(await new Go2rtcApi({ port: s.port, username: 'u', password: 'p' }).ping(), true);
    } finally { await s.close(); }
    assert.equal(await new Go2rtcApi({ port: await getClosedPort(), username: 'u', password: 'p' }).ping(), false);
});

test('waitReady: go2rtc 가 응답할 때까지 기다리고, 끝내 응답이 없으면 false', async () => {
    let up = 0;
    const s = await fakeServer((r, res) => { res.statusCode = ++up >= 3 ? 200 : 503; res.end('{}'); });
    try {
        const api = new Go2rtcApi({ port: s.port, username: 'u', password: 'p' });
        assert.equal(await api.waitReady({ tries: 5, intervalMs: 10 }), true);
        assert.equal(s.requests.length, 3);
    } finally { await s.close(); }
    const dead = new Go2rtcApi({ port: await getClosedPort(), username: 'u', password: 'p' });
    assert.equal(await dead.waitReady({ tries: 3, intervalMs: 10 }), false);
});
