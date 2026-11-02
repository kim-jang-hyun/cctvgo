'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerLiveRoutes } = require('../streams/live-routes');

const MISMATCH = { ok: false, status: 500, body: 'streams: codecs not matched: video:H265 => video:H264' };
const answer = name => ({ ok: true, status: 201, body: `v=0 answer ${name}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n` });
// go2rtc 는 영상 코덱이 안 맞아도 음성만 맞으면 영상을 inactive 로 둔 답을 201 로 준다 (실기 확인: H.265 카메라 + PC 크롬)
const AUDIO_ONLY = { ok: true, status: 201, body: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\na=inactive\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=sendonly\r\n' };

/** variants: k → [{variant, name}], replies: name → offer 결과 */
async function startApp({ variants = {}, replies = {}, now, alive = true } = {}) {
    const offers = [];
    const events = [];
    const api = { async offer(name, sdp) { offers.push({ name, sdp }); return replies[name] || { ok: false, status: 404, body: '' }; }, async ping() { return alive; } };
    const streams = { epoch: 'E1', variantsOf: k => variants[k] || [] };
    const diag = { connection: e => events.push(e) };
    const app = express();
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerLiveRoutes(app, { authMiddleware, streams, api, diag, ...(now ? { now } : {}) });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const offer = (path, sdp = 'v=0 offer', auth = true, extra = {}) => fetch(base + path, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/sdp', ...(auth ? { 'x-test-auth': 'ok' } : {}), ...extra },
        body: sdp,
    });
    return { offer, offers, events, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

const H265_CAM = { 1: [{ variant: 'main', name: 'cctvgo_k1' }, { variant: 'sub', name: 'cctvgo_k1_sub' }, { variant: 'h264', name: 'cctvgo_k1_h264' }] };

test('로그인하지 않으면 go2rtc 에 닿지 않는다', async () => {
    const app = await startApp({ variants: H265_CAM });
    try {
        const res = await app.offer('/api/live/1/offer?epoch=E1&h265=0', 'v=0', false);
        assert.equal(res.status, 302);
        assert.equal(app.offers.length, 0);
    } finally { await app.close(); }
});

test('카메라 번호가 숫자가 아니면 400 이고 go2rtc 에 닿지 않는다', async () => {
    const app = await startApp({ variants: H265_CAM });
    try {
        for (const k of ['abc', '1%26src%3Dexec%3Ax', '1.5', '12345', '-1']) {
            const res = await app.offer(`/api/live/${k}/offer?epoch=E1&h265=0`);
            assert.equal(res.status, 400, k);
        }
        assert.equal(app.offers.length, 0);
    } finally { await app.close(); }
});

test('H.265 를 받을 수 있는 브라우저는 원본만 시도한다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: answer('cctvgo_k1') } });
    try {
        const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=1')).json();
        assert.deepEqual(body, { status: 'success', sdp: answer('cctvgo_k1').body, variant: 'main' });
        assert.deepEqual(app.offers.map(o => o.name), ['cctvgo_k1']);
        assert.equal(app.offers[0].sdp, 'v=0 offer');
    } finally { await app.close(); }
});

test('H.265 를 못 받으면 코덱 불일치일 때만 서브로 넘어간다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: MISMATCH, cctvgo_k1_sub: answer('sub') } });
    try {
        const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json();
        assert.equal(body.variant, 'sub');
        assert.deepEqual(app.offers.map(o => o.name), ['cctvgo_k1', 'cctvgo_k1_sub']);
    } finally { await app.close(); }
});

test('서브도 맞지 않으면 변환본으로 넘어간다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: MISMATCH, cctvgo_k1_sub: MISMATCH, cctvgo_k1_h264: answer('h') } });
    try {
        const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json();
        assert.equal(body.variant, 'h264');
    } finally { await app.close(); }
});

test('모두 코덱이 맞지 않으면 reason:codec', async () => {
    const app = await startApp({ variants: { 1: [{ variant: 'main', name: 'cctvgo_k1' }] }, replies: { cctvgo_k1: MISMATCH } });
    try {
        const res = await app.offer('/api/live/1/offer?epoch=E1&h265=0');
        const body = await res.json();
        assert.equal(body.status, 'error');
        assert.equal(body.reason, 'codec');
    } finally { await app.close(); }
});

test('원본이 404/연결 실패면 다음을 시도하지 않고 reason:unavailable', async () => {
    for (const reply of [{ ok: false, status: 404, body: '' }, { ok: false, status: 0, body: 'ECONNREFUSED' }]) {
        const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: reply } });
        try {
            const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json();
            assert.equal(body.reason, 'unavailable');
            assert.deepEqual(app.offers.map(o => o.name), ['cctvgo_k1']);
        } finally { await app.close(); }
    }
});

test('없는 카메라 번호는 reason:not_found 이고 go2rtc 에 닿지 않는다', async () => {
    const app = await startApp({ variants: H265_CAM });
    try {
        const body = await (await app.offer('/api/live/7/offer?epoch=E1&h265=0')).json();
        assert.equal(body.reason, 'not_found');
        assert.equal(app.offers.length, 0);
    } finally { await app.close(); }
});

test('SDP 가 비었거나 32KB 를 넘으면 거절한다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: answer('cctvgo_k1') } });
    try {
        assert.equal((await app.offer('/api/live/1/offer?epoch=E1&h265=1', '')).status, 400);
        assert.equal((await app.offer('/api/live/1/offer?epoch=E1&h265=1', 'v'.repeat(33 * 1024))).status, 413);
        assert.equal(app.offers.length, 0);
    } finally { await app.close(); }
});

test('연결 요청마다 기록을 남긴다 (시청자 IP 포함 원본은 diag 가 마스킹)', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: MISMATCH, cctvgo_k1_sub: answer('sub') } });
    try {
        await app.offer('/api/live/1/offer?epoch=E1&h265=0', 'v=0', true, { 'cf-connecting-ip': '211.36.147.187', 'user-agent': 'TestUA' });
        assert.equal(app.events.length, 1);
        const e = app.events[0];
        assert.equal(e.stage, 'signaling');
        assert.equal(e.k, 1);
        assert.equal(e.ok, true);
        assert.equal(e.variant, 'sub');
        assert.equal(e.h265, false);
        assert.equal(e.ua, 'TestUA');
        assert.equal(e.ip, '211.36.147.187');
        assert.equal(typeof e.ms, 'number');
    } finally { await app.close(); }
});

test('서버가 다시 시작해 번호 체계(epoch)가 바뀌었으면 409 stale 이고 go2rtc 에 닿지 않는다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: answer('x') } });
    try {
        for (const q of ['epoch=OLD&h265=0', 'h265=0']) {
            const res = await app.offer(`/api/live/1/offer?${q}`);
            assert.equal(res.status, 409, q);
            assert.equal((await res.json()).reason, 'stale');
        }
        assert.equal(app.offers.length, 0);
    } finally { await app.close(); }
});

test('답에 영상이 없으면(음성만, 영상 inactive) 코덱 불일치로 보고 다음으로 넘어간다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: AUDIO_ONLY, cctvgo_k1_sub: AUDIO_ONLY, cctvgo_k1_h264: answer('h') } });
    try {
        const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json();
        assert.equal(body.variant, 'h264');
        assert.deepEqual(app.offers.map(o => o.name), ['cctvgo_k1', 'cctvgo_k1_sub', 'cctvgo_k1_h264']);
    } finally { await app.close(); }
});

test('영상 줄이 없거나 포트 0 인 답도 영상 없음으로 본다', async () => {
    const noVideo = { ok: true, status: 201, body: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=sendonly\r\n' };
    const port0 = { ok: true, status: 201, body: 'v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' };
    for (const reply of [noVideo, port0]) {
        const app = await startApp({ variants: { 1: [{ variant: 'main', name: 'cctvgo_k1' }] }, replies: { cctvgo_k1: reply } });
        try {
            assert.equal((await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json()).reason, 'codec');
        } finally { await app.close(); }
    }
});

test('원본/서브가 코덱 때문에 안 된 카메라는 다음 연결부터 바로 변환본으로 (카메라 접속을 줄이고 첫 화면을 빨리)', async () => {
    let t = 1000;
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: MISMATCH, cctvgo_k1_sub: MISMATCH, cctvgo_k1_h264: answer('h') }, now: () => t });
    try {
        await app.offer('/api/live/1/offer?epoch=E1&h265=0');
        app.offers.length = 0;
        const body = await (await app.offer('/api/live/1/offer?epoch=E1&h265=0')).json();
        assert.equal(body.variant, 'h264');
        assert.deepEqual(app.offers.map(o => o.name), ['cctvgo_k1_h264']);
        // H.265 를 받는 브라우저는 따로 기억한다 (원본부터)
        app.offers.length = 0;
        await app.offer('/api/live/1/offer?epoch=E1&h265=1');
        assert.equal(app.offers[0].name, 'cctvgo_k1');
        // 10분이 지나면 다시 원본부터 확인한다 (카메라 설정이 바뀌었을 수 있음)
        t += 10 * 60 * 1000 + 1;
        app.offers.length = 0;
        await app.offer('/api/live/1/offer?epoch=E1&h265=0');
        assert.equal(app.offers[0].name, 'cctvgo_k1');
    } finally { await app.close(); }
});

test('실패 응답은 5xx 를 쓰지 않는다 (Cloudflare 가 5xx 응답을 자기 오류 페이지로 바꿔 화면이 이유를 읽지 못함, 실기 발견)', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: { ok: false, status: 500, body: 'streams: dial tcp 192.168.219.100:554: i/o timeout' } } });
    try {
        const res = await app.offer('/api/live/1/offer?epoch=E1&h265=0');
        assert.ok(res.status < 500, String(res.status));
        assert.equal((await res.json()).reason, 'unavailable');
    } finally { await app.close(); }
});

test('go2rtc 자체가 응답하지 않으면(실행 안 됨) reason:media_server 로 구분한다', async () => {
    const app = await startApp({ variants: H265_CAM, replies: { cctvgo_k1: { ok: false, status: 0, body: 'fetch failed' } }, alive: false });
    try {
        const res = await app.offer('/api/live/1/offer?epoch=E1&h265=0');
        assert.equal(res.status, 424);
        const body = await res.json();
        assert.equal(body.reason, 'media_server');
        assert.equal(app.events[0].reason, 'media_server');
    } finally { await app.close(); }
});
