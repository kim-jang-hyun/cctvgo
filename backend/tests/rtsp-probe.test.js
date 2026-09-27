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
