'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findStream, BOGUS_PATH } = require('../finder/find-stream');
const { AuthBudget } = require('../finder/guard');
const { createMockRtsp } = require('./helpers/mock-rtsp');
const { createMockOnvif } = require('./helpers/mock-onvif');

const HOST = '127.0.0.1';
const paths = list => list.map(p => ({ path: p, vendors: [] }));
const settingsFor = (list, onvifPorts = []) => ({ paths: paths(list), onvifPorts, onvifServicePaths: ['/onvif/device_service'] });

function run(cam, extra = {}) {
    return findStream({
        host: HOST,
        username: 'admin',
        password: 'pw',
        budget: new AuthBudget(),
        settings: settingsFor(['/a', '/b', '/c']),
        rtspPorts: [cam.port],
        rtspTimeoutMs: 1000,
        onvifTimeoutMs: 1000,
        ...extra,
    });
}

test('잘못된 경로에 404를 주는 카메라: 후보를 끝까지 시도해 찾고 인증 실패는 0회', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/b`);
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
        assert.ok(cam.state.requests.some(q => q.path === BOGUS_PATH), '성향 감지 요청을 보냈다');
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 인증 실패는 최대 2회에서 멈춘다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { password: 'wrong', budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, 2);
        assert.equal(budget.isExhausted(HOST), true);
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라: 예산(2회) 안에서만 시도한다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'], unknownPathStatus: 401 });
    try {
        const r = await run(cam);   // 후보 순서 /a,/b,/c → 성향 감지 1회 + /a 1회로 예산 소진
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, 2);
        assert.ok(!cam.state.requests.some(q => q.path === '/b' && q.authed), '/b 는 시도하지 않는다');
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라라도 첫 후보가 맞으면 찾는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'], unknownPathStatus: 401 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/a`);
        assert.equal(budget.failures(HOST), 0, '성공하면 예산을 초기화한다');
    } finally { await cam.close(); }
});

test('예산이 소진된 카메라에는 어떤 요청도 보내지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        budget.recordFailure(HOST); budget.recordFailure(HOST);
        const r = await run(cam, { budget });
        assert.equal(r.status, 'auth_locked');
        assert.ok(r.retryAfterSec > 0);
        assert.equal(cam.state.requests.length, 0);
    } finally { await cam.close(); }
});

test('인증이 필요 없는 카메라는 계정 없이 찾는다', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/c'] });
    try {
        const r = await run(cam, { username: '', password: '' });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://${HOST}:${cam.port}/c`);
    } finally { await cam.close(); }
});

test('계정 없이 인증이 필요한 카메라는 auth_failed (요청 예산 소모 없음)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { username: '', password: '', budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(budget.failures(HOST), 0);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('직접 입력 경로: 맞으면 found(manual), 틀리면 path_not_found', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const ok = await run(cam, { path: '/b', port: cam.port });
        assert.equal(ok.status, 'found');
        assert.equal(ok.candidates[0].source, 'manual');
        const bad = await run(cam, { path: '/zzz', port: cam.port });
        assert.equal(bad.status, 'path_not_found');
    } finally { await cam.close(); }
});

test('열린 RTSP 포트가 없으면 unreachable', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    const port = cam.port;
    await cam.close();
    const r = await run({ port }, {});
    assert.equal(r.status, 'unreachable');
});

test('ONVIF: 주소를 받아 재검증하고 성향 감지 없이 찾는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/onvif/profile1', '/onvif/profile2'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.deepEqual(r.candidates.map(c => c.source), ['onvif', 'onvif']);
        assert.deepEqual(r.candidates.map(c => c.label), ['main', 'sub']);
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/onvif/profile1`);
        assert.ok(!rtsp.state.requests.some(q => q.path === BOGUS_PATH));
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF가 알려 준 주소가 실제로 접속되지 않으면 채택하지 않고 경로 후보로 폴백한다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });   // ONVIF 가 알려 주는 /onvif/profile* 는 없음
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/b`);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF 인증 실패 + RTSP 인증 실패를 합쳐도 카메라가 본 인증 실패는 2회 이하', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        const r = await run(rtsp, { password: 'wrong', budget, settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.ok(onvif.state.failedAuth + rtsp.state.failedAuth <= 2, `${onvif.state.failedAuth}+${rtsp.state.failedAuth}`);
        assert.equal(budget.isExhausted(HOST), true);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('진단 정보에는 호스트/서버 헤더/시도 목록이 있고 비밀번호는 없다', async () => {
    const cam = await createMockRtsp({ users: { admin: 'S3cr3t!x' }, validPaths: ['/nothing'] });
    try {
        const r = await run(cam, { password: 'S3cr3t!x', vendorHint: 'Acme Cam' });
        assert.equal(r.status, 'path_not_found');
        assert.match(r.diagnostics, /카메라 IP: 127\.0\.0\.1/);
        assert.match(r.diagnostics, /Acme Cam/);
        assert.match(r.diagnostics, /MockCam\/1\.0/);
        assert.match(r.diagnostics, /realm/i);
        assert.match(r.diagnostics, /\/a → 404/);
        assert.ok(!r.diagnostics.includes('S3cr3t'));
        assert.ok(!JSON.stringify(r.tried).includes('S3cr3t'));
    } finally { await cam.close(); }
});
