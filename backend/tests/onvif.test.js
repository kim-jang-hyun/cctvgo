'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getStreamUris, parseUtcOffset, parseProfiles, parseUri } = require('../finder/onvif');
const { createMockOnvif } = require('./helpers/mock-onvif');
const { getClosedPort } = require('./helpers/ports');

const HOST = '127.0.0.1';
const SERVICE = ['/onvif/device_service'];

test('parseUtcOffset: 네임스페이스 접두사와 관계없이 카메라 시각과의 차이를 계산한다', () => {
    const future = new Date(Date.now() + 3600 * 1000);
    const xml = `<a:UTCDateTime><b:Time><b:Hour>${future.getUTCHours()}</b:Hour><b:Minute>${future.getUTCMinutes()}</b:Minute><b:Second>${future.getUTCSeconds()}</b:Second></b:Time>`
        + `<b:Date><b:Year>${future.getUTCFullYear()}</b:Year><b:Month>${future.getUTCMonth() + 1}</b:Month><b:Day>${future.getUTCDate()}</b:Day></b:Date></a:UTCDateTime>`;
    const offset = parseUtcOffset(xml);
    assert.ok(Math.abs(offset - 3600 * 1000) < 2000, String(offset));
    assert.equal(parseUtcOffset('<x/>'), null);
});

test('parseProfiles / parseUri', () => {
    const xml = '<trt:Profiles token="p1"><tt:Name>main</tt:Name><tt:VideoSourceConfiguration><tt:Name>v</tt:Name></tt:VideoSourceConfiguration></trt:Profiles>'
        + '<trt:Profiles token="p2" fixed="true"><tt:Name>sub</tt:Name></trt:Profiles>';
    assert.deepEqual(parseProfiles(xml), [{ token: 'p1', name: 'main' }, { token: 'p2', name: 'sub' }]);
    assert.equal(parseUri('<tt:Uri>rtsp://1.2.3.4:554/a?b=1&amp;c=2</tt:Uri>'), 'rtsp://1.2.3.4:554/a?b=1&c=2');
    assert.equal(parseUri('<x/>'), null);
});

test('올바른 계정이면 프로파일별 스트림 URI를 돌려준다', async () => {
    const cam = await createMockOnvif({ rtspPort: 5540 });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.uris.map(u => u.name), ['main', 'sub']);
        assert.equal(r.uris[0].uri, 'rtsp://0.0.0.0:5540/onvif/profile1');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('카메라 시계가 10분 어긋나 있어도 시차를 보정해 인증한다', async () => {
    const cam = await createMockOnvif({ clockOffsetMs: 10 * 60 * 1000 });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 auth_failed 이고 인증 요청은 1번만 보낸다', async () => {
    const cam = await createMockOnvif();
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'wrong', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'auth_failed');
        assert.equal(cam.state.failedAuth, 1);
    } finally { await cam.close(); }
});

test('ONVIF가 없으면 unsupported', async () => {
    const closed = await getClosedPort();
    const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [closed], servicePaths: SERVICE, timeoutMs: 500 });
    assert.deepEqual(r, { status: 'unsupported' });
});

test('SOAP이 아닌 웹서버(404)는 unsupported 이고 인증 실패로 세지 않는다', async () => {
    const http = require('http');
    const web = http.createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cam"' }); res.end(); });
    await new Promise(r => web.listen(0, HOST, r));
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [web.address().port], servicePaths: SERVICE, timeoutMs: 1000 });
        assert.deepEqual(r, { status: 'unsupported' });
    } finally { web.close(); }
});

test('GetStreamUri만 인증을 요구하는 카메라도 틀린 비밀번호면 인증 요청 1번 만에 auth_failed', async () => {
    const cam = await createMockOnvif({ anonymousProfiles: true });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'wrong', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'auth_failed');
        assert.equal(cam.state.failedAuth, 1);
    } finally { await cam.close(); }
});

test('비표준 거절 문구여도 여러 포트/경로에 자격 증명을 보내지 않고 인증 요청 1번 만에 auth_failed', async () => {
    const a = await createMockOnvif({ canonicalFault: false, faultText: 'Authentication failed for user' });
    const b = await createMockOnvif({ canonicalFault: false, faultText: 'Authentication failed for user' });
    try {
        const r = await getStreamUris({
            host: HOST, username: 'admin', password: 'wrong', ports: [a.port, b.port],
            servicePaths: ['/onvif/device_service', '/onvif/device_service'],
        });
        assert.equal(r.status, 'auth_failed');
        assert.equal(a.state.credentialed, 1);
        assert.equal(a.state.failedAuth, 1);
        assert.equal(b.state.credentialed, 0);
        assert.equal(b.state.failedAuth, 0);
    } finally { await a.close(); await b.close(); }
});

test('아이디가 비어 있으면 자격 증명 요청을 보내지 않고 unsupported', async () => {
    const cam = await createMockOnvif();
    try {
        const r = await getStreamUris({ host: HOST, username: '', password: '', ports: [cam.port], servicePaths: SERVICE });
        assert.deepEqual(r, { status: 'unsupported' });
        assert.equal(cam.state.credentialed, 0);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('존재하지 않는 미디어 경로(404)는 자격 증명 없이 건너뛰고 다음 경로에서 성공한다', async () => {
    // Capabilities 는 /onvif/media_service 를 알려 주지만 이 카메라는 /onvif/media 에서만 응답한다
    const cam = await createMockOnvif({ mediaPaths: ['/onvif/media'] });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.equal(cam.state.failedAuth, 0);
        // 404 였던 /onvif/media_service 로는 GetProfiles 를 한 번(자격 증명 없이)만 보냈다
        const hits = cam.state.requests.filter(q => q.path === '/onvif/media_service');
        assert.equal(hits.length, 1);
    } finally { await cam.close(); }
});

test('잘못된 비밀번호 + 일부 경로만 응답하는 카메라: 자격 증명 요청은 1번뿐', async () => {
    const cam = await createMockOnvif({ mediaPaths: ['/onvif/media'], canonicalFault: false, faultText: 'Authentication failed for user' });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'bad', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'auth_failed');
        assert.equal(cam.state.credentialed, 1);
    } finally { await cam.close(); }
});

test('자격 증명 없는 요청을 HTTP 401(HTML)로 거절하는 카메라(실기 FX327): Capabilities 의 미디어 경로로 인증해 찾는다', async () => {
    const cam = await createMockOnvif({ httpAuthChallenge: true, mediaPaths: ['/onvif/Media'], capsMediaPath: '/onvif/Media' });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'pw', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.uris.map(u => u.name), ['main', 'sub']);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('HTTP 401 카메라 + 틀린 비밀번호: Capabilities 의 미디어 경로에만 1번 보내고 auth_failed', async () => {
    const cam = await createMockOnvif({ httpAuthChallenge: true, mediaPaths: ['/onvif/Media'], capsMediaPath: '/onvif/Media' });
    try {
        const r = await getStreamUris({ host: HOST, username: 'admin', password: 'wrong', ports: [cam.port], servicePaths: SERVICE });
        assert.equal(r.status, 'auth_failed');
        assert.equal(cam.state.credentialed, 1);
        assert.deepEqual(cam.state.requests.filter(q => q.authed).map(q => q.path), ['/onvif/Media']);
    } finally { await cam.close(); }
});

test('HTTP 401 카메라라도 Capabilities 가 알려 주지 않은 경로에는 자격 증명을 보내지 않는다', async () => {
    // 이 카메라는 경로와 관계없이 401 을 주므로 401 만으로는 경로가 있다는 증거가 아니다
    const cam = await createMockOnvif({ httpAuthChallenge: true, mediaPaths: ['/onvif/Media'], capsMediaPath: '/onvif/Media' });
    try {
        await getStreamUris({ host: HOST, username: 'admin', password: 'wrong', ports: [cam.port], servicePaths: SERVICE });
        assert.ok(!cam.state.requests.some(q => q.authed && q.path !== '/onvif/Media'));
    } finally { await cam.close(); }
});
