'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../finder/rtsp-probe');
const { createMockRtsp } = require('./helpers/mock-rtsp');
const { getClosedPort } = require('./helpers/ports');

const HOST = '127.0.0.1';

test('Digest 인증: 올바른 계정이면 ok', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
        assert.equal(r.code, 200);
        assert.equal(r.authSent, true);
        assert.equal(r.headers.server, 'MockCam/1.0');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('Digest qop=auth 인증도 지원한다', async () => {
    const cam = await createMockRtsp({ qop: true, validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('Basic 인증을 지원한다', async () => {
    const cam = await createMockRtsp({ scheme: 'basic', validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 unauthorized 이고 authSent=true', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'wrong' });
        assert.equal(r.status, 'unauthorized');
        assert.equal(r.authSent, true);
        assert.equal(cam.state.failedAuth, 1);
    } finally { await cam.close(); }
});

test('경로가 없으면 not_found (계정은 맞음)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/nope', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'not_found');
        assert.equal(r.authSent, true);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('인증이 필요 없는 카메라는 계정 없이 ok', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1' });
        assert.equal(r.status, 'ok');
        assert.equal(r.authSent, false);
    } finally { await cam.close(); }
});

test('계정을 주지 않으면 401은 authSent=false 로 끝난다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1' });
        assert.equal(r.status, 'unauthorized');
        assert.equal(r.authSent, false);
        assert.match(r.headers['www-authenticate'], /Digest realm="mock"/);
    } finally { await cam.close(); }
});

test('쿼리가 있는 경로도 처리한다', async () => {
    const p = '/cam/realmonitor?channel=1&subtype=0';
    const cam = await createMockRtsp({ validPaths: [p] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: p, username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
    } finally { await cam.close(); }
});

test('닫힌 포트는 unreachable', async () => {
    const port = await getClosedPort();
    const r = await describe({ host: HOST, port, path: '/x', username: 'a', password: 'b', timeoutMs: 500 });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.authSent, false);
});

test('지원하지 않는 Digest algorithm(SHA-256)만 광고하면 자격 증명을 보내지 않는다', async () => {
    const cam = await createMockRtsp({ algorithms: ['SHA-256'], validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'other');
        assert.equal(r.code, 401);
        assert.equal(r.authSent, false);
        assert.equal(r.reason, 'unsupported-auth');
        assert.ok(r.headers['www-authenticate']);
        assert.equal(cam.state.failedAuth, 0);
        assert.ok(cam.state.requests.every(q => !q.authed), 'Authorization 헤더를 보내지 않았다');
    } finally { await cam.close(); }
});

test('MD5-sess 만 광고해도 자격 증명을 보내지 않는다', async () => {
    const cam = await createMockRtsp({ algorithms: ['MD5-sess'], validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.reason, 'unsupported-auth');
        assert.equal(r.authSent, false);
    } finally { await cam.close(); }
});

test('Digest 챌린지가 여러 개면 MD5 를 골라 정상 인증한다', async () => {
    const cam = await createMockRtsp({ algorithms: ['SHA-256', 'MD5'], validPaths: ['/stream1'] });
    try {
        const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username: 'admin', password: 'pw' });
        assert.equal(r.status, 'ok');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('parseChallenge: MD5 Digest > Basic > 사용 불가 우선순위', () => {
    const { parseChallenge } = require('../finder/rtsp-probe');
    assert.equal(parseChallenge('Digest realm="a", nonce="n", algorithm=SHA-256, Basic realm="b"').scheme, 'basic');
    assert.equal(parseChallenge('Basic realm="b", Digest realm="a", nonce="n", algorithm=md5').scheme, 'digest');
    assert.equal(parseChallenge('Digest realm="a", nonce="n", algorithm=SHA-256').scheme, 'unsupported');
    assert.equal(parseChallenge('Negotiate').scheme, 'unsupported');
    assert.equal(parseChallenge(''), null);
});

test('username 에 제어문자/따옴표가 있으면 요청을 보내지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/stream1'] });
    try {
        for (const username of ['ad"min', 'ad\r\nX: 1', 'a\x00b', 'a\x7fb']) {
            const r = await describe({ host: HOST, port: cam.port, path: '/stream1', username, password: 'pw' });
            assert.equal(r.status, 'other');
            assert.equal(r.code, 0);
            assert.equal(r.authSent, false);
            assert.equal(r.reason, 'invalid-credentials');
        }
        assert.equal(cam.state.requests.length, 0, '소켓 요청 없음');
    } finally { await cam.close(); }
});
