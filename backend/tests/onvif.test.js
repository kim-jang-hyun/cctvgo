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
