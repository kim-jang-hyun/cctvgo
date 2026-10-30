'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig, streamNames, DEFAULT_PORTS } = require('../streams/go2rtc-config');

const base = { apiPort: 1984, rtspPort: 8554, webrtcPort: 8555, username: 'u', password: 'p' };

test('기본 포트는 API 1984, RTSP 8554, WebRTC 8555', () => {
    assert.deepEqual(DEFAULT_PORTS, { api: 1984, rtsp: 8554, webrtc: 8555 });
});

test('관리 API 와 내부 RTSP 는 127.0.0.1 에만 열고, 같은 PC 요청에도 인증을 요구한다', () => {
    const y = buildConfig({ ...base, streams: {} });
    assert.match(y, /api:\n {2}listen: "127\.0\.0\.1:1984"/);
    assert.match(y, /local_auth: true/);
    assert.match(y, /username: "u"/);
    assert.match(y, /password: "p"/);
    assert.match(y, /rtsp:\n {2}listen: "127\.0\.0\.1:8554"/);
});

test('WebRTC 는 모든 주소에 열고, STUN 으로 바깥 주소를 알린다 (무료 공용 STUN 만)', () => {
    const y = buildConfig({ ...base, streams: {} });
    assert.match(y, /webrtc:\n {2}listen: ":8555"/);
    assert.match(y, /candidates:\n {4}- "stun:8555"/);
    assert.match(y, /stun:stun\.l\.google\.com:19302/);
});

test('비밀번호에 특수문자가 있는 카메라 주소도 YAML 문자열로 그대로 들어간다', () => {
    const src = 'rtsp://admin:a%21b$c#"d@192.168.0.5:554/x';
    const y = buildConfig({ ...base, streams: { s1: src } });
    assert.ok(y.includes(`  "s1": ${JSON.stringify(src)}`));
});

test('스트림이 없으면 streams: {} 를 쓴다', () => {
    assert.match(buildConfig({ ...base, streams: {} }), /streams: \{\}/);
});

test('streamNames: 원본, 서브, PC 변환본 이름', () => {
    assert.deepEqual(streamNames(12), { main: 's12', sub: 's12_sub', h264: 's12_h264' });
});
