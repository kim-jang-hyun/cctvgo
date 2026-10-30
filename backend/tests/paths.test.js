'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSettings, orderedPaths, BUILT_IN_PATHS } = require('../finder/paths');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-paths-'));
}

test('내장 후보에 실제 카메라 경로가 들어 있고 80개 이상이다', () => {
    const list = orderedPaths(loadSettings(tmpDir()));
    assert.ok(list.includes('/Streaming/Channels/101'));
    assert.ok(list.includes('/onvif1'));
    assert.ok(list.length >= 80, `후보 수: ${list.length}`);
    assert.equal(new Set(list).size, list.length, '중복 없음');
});

test('외부 rtsp-paths.json이 없으면 내장 값만 쓴다', () => {
    const s = loadSettings(tmpDir());
    assert.equal(s.paths.length, BUILT_IN_PATHS.length);
    assert.deepEqual(s.onvifPorts.slice(0, 3), [80, 8080, 2020]);
    assert.ok(s.onvifServicePaths.includes('/onvif/device_service'));
});

test('외부 파일의 값은 내장 값에 합쳐지고 경로는 맨 앞에 온다', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), JSON.stringify({
        paths: ['/custom/ch1', '/onvif1'],
        onvifPorts: [9999, 80],
        onvifServicePaths: ['/custom/onvif'],
    }));
    const s = loadSettings(dir);
    const list = orderedPaths(s);
    assert.equal(list[0], '/custom/ch1');
    assert.equal(list[1], '/onvif1');
    assert.equal(new Set(list).size, list.length);
    assert.ok(s.onvifPorts.includes(9999));
    assert.equal(s.onvifPorts.filter(p => p === 80).length, 1);
    assert.ok(s.onvifServicePaths.includes('/custom/onvif'));
});

test('외부 파일이 깨져 있거나 형식이 틀리면 무시한다', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), '{ not json');
    assert.equal(loadSettings(dir).paths.length, BUILT_IN_PATHS.length);

    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), JSON.stringify({ paths: [1, null, '', 'nosl', '/ok'], onvifPorts: ['80', 0, 70000, 8081] }));
    const s = loadSettings(dir);
    const list = orderedPaths(s);
    assert.equal(list[0], '/ok');
    assert.ok(!list.includes('nosl') && !list.includes(''));
    assert.ok(s.onvifPorts.includes(8081) && !s.onvifPorts.includes(0) && !s.onvifPorts.includes(70000));
});

test('제조사 힌트가 있으면 해당 제조사 경로가 앞선다', () => {
    const s = loadSettings(tmpDir());
    assert.equal(orderedPaths(s, 'Reolink RLC-510A')[0], '/h264Preview_01_main');
    assert.equal(orderedPaths(s, 'DAHUA')[0], '/cam/realmonitor?channel=1&subtype=0');
    assert.equal(orderedPaths(s, '알 수 없는 제조사')[0], '/Streaming/Channels/101');
});

test('외부 경로는 내장 후보와 겹쳐도 항상 맨 앞에 온다 (외부 파일 순서 유지)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'rtsp-paths.json'), JSON.stringify({ paths: ['/ipcam.sdp', '/custom/x', '/onvif1'] }));
    const list = orderedPaths(loadSettings(dir), 'hikvision');
    assert.deepEqual(list.slice(0, 3), ['/ipcam.sdp', '/custom/x', '/onvif1']);
    assert.equal(list[3], '/Streaming/Channels/101', '그 다음은 제조사 힌트 일치 내장 경로');
    assert.equal(new Set(list).size, list.length, '중복 없음');
    assert.equal(list.filter(p => p === '/ipcam.sdp').length, 1);
});

// --- 서브 스트림 경로 ---
const { subPathFor } = require('../finder/paths');

test('subPathFor: 흔한 메인 경로를 서브 경로로 바꾼다', () => {
    const cases = {
        '/Streaming/Channels/101': '/Streaming/Channels/102',
        '/Streaming/Channels/201': '/Streaming/Channels/202',
        '/cam/realmonitor?channel=1&subtype=0': '/cam/realmonitor?channel=1&subtype=1',
        '/h264Preview_01_main': '/h264Preview_01_sub',
        '/h264/ch1/main/av_stream': '/h264/ch1/sub/av_stream',
        '/stream1': '/stream2',
        '/onvif1': '/onvif2',
        '/profile1/media.smp': '/profile2/media.smp',
        '/onvif/profile1/media.smp': '/onvif/profile2/media.smp',
        '/live/ch00_0': '/live/ch00_1',
        '/videoMain': '/videoSub',
        '/media/video1': '/media/video2',
        '/live1.sdp': '/live2.sdp',
        '/unicast/c1/s0/live': '/unicast/c1/s1/live',
        '/s0': '/s1',
        '/11': '/12',
    };
    for (const [main, sub] of Object.entries(cases)) assert.equal(subPathFor(main), sub, main);
});

test('subPathFor: 해당 규칙이 없으면 null', () => {
    for (const p of ['/live', '/h264', '/ch01', '/axis-media/media.amp', '/stream2', '/onvif2']) assert.equal(subPathFor(p), null, p);
});
