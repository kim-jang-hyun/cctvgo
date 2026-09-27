'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeCred, buildRtspUrl, parseCameras, applyCameraLine, saveCameraLine } = require('../finder/cctv-file');

const SAMPLE = [
    '# [CCTV 연결 설정 가이드]',
    '',
    '# ↓ 아래에 카메라 정보를 입력하세요',
    'rtsp://admin:start%244962@192.168.219.100:554/Streaming/Channels/101, 거실',
    'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1, 안방',
].join('\r\n');

test('encodeCred: 기존 코드표와 같은 방식으로 인코딩한다', () => {
    assert.equal(encodeCred('start$4962'), 'start%244962');
    assert.equal(encodeCred('dash1101!'), 'dash1101%21');
    assert.equal(encodeCred('a*b'), 'a%2Ab');
    assert.equal(encodeCred("a'b(c)"), 'a%27b%28c%29');
    assert.equal(encodeCred('p#w@d:/?'), 'p%23w%40d%3A%2F%3F');
    assert.equal(encodeCred('한글'), encodeURIComponent('한글'));
});

test('buildRtspUrl: 인증 정보가 있으면 포함한다', () => {
    assert.equal(
        buildRtspUrl({ username: 'admin', password: 'pass#1', host: '192.168.0.10', port: 554, path: '/stream1' }),
        'rtsp://admin:pass%231@192.168.0.10:554/stream1'
    );
    assert.equal(
        buildRtspUrl({ username: '', password: '', host: '192.168.0.10', port: 8554, path: 'live' }),
        'rtsp://192.168.0.10:8554/live'
    );
});

test('parseCameras: 주석/빈 줄을 제외하고 주소와 이름을 읽는다', () => {
    const cams = parseCameras(SAMPLE);
    assert.equal(cams.length, 2);
    assert.deepEqual(cams[1], { index: 1, url: 'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1', name: '안방' });
});

test('applyCameraLine append: 주석을 보존하고 CRLF로 끝에 추가한다', () => {
    const r = applyCameraLine(SAMPLE, { url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.index, 2);
    assert.ok(r.text.startsWith('# [CCTV 연결 설정 가이드]\r\n\r\n# ↓'));
    assert.ok(r.text.endsWith('안방\r\nrtsp://a:b@192.168.0.5:554/x, 주방\r\n'));
    assert.equal(parseCameras(r.text).length, 3);
});

test('applyCameraLine append: LF 파일은 LF를 유지하고 빈 파일은 CRLF', () => {
    const lf = applyCameraLine('# c\nrtsp://a:b@10.0.0.1:554/x, 1\n', { url: 'rtsp://a:b@10.0.0.2:554/y', name: '2', mode: 'append' });
    assert.equal(lf.text, '# c\nrtsp://a:b@10.0.0.1:554/x, 1\nrtsp://a:b@10.0.0.2:554/y, 2\n');
    const empty = applyCameraLine('', { url: 'rtsp://a:b@10.0.0.2:554/y', name: '2', mode: 'append' });
    assert.equal(empty.text, 'rtsp://a:b@10.0.0.2:554/y, 2\r\n');
});

test('applyCameraLine replace: 지정한 카메라 줄만 교체한다', () => {
    const r = applyCameraLine(SAMPLE, { url: 'rtsp://n:p@192.168.0.9:554/z', name: '새 안방', mode: 'replace', replaceIndex: 1 });
    const cams = parseCameras(r.text);
    assert.equal(cams.length, 2);
    assert.equal(cams[0].name, '거실');
    assert.deepEqual(cams[1], { index: 1, url: 'rtsp://n:p@192.168.0.9:554/z', name: '새 안방' });
    assert.ok(r.text.includes('# [CCTV 연결 설정 가이드]'));
});

test('applyCameraLine replace: 범위를 벗어나면 오류', () => {
    assert.throws(() => applyCameraLine(SAMPLE, { url: 'rtsp://x', name: 'n', mode: 'replace', replaceIndex: 5 }), /교체할 카메라/);
    assert.throws(() => applyCameraLine(SAMPLE, { url: 'rtsp://x', name: 'n', mode: 'replace' }), /교체할 카메라/);
});

test('이름의 콤마/줄바꿈은 제거하고 비어 있으면 기본 이름을 쓴다', () => {
    const a = applyCameraLine('', { url: 'rtsp://a@10.0.0.1:554/x', name: '거실, 큰방\n2', mode: 'append' });
    assert.equal(parseCameras(a.text)[0].name, '거실 큰방 2');
    const b = applyCameraLine('', { url: 'rtsp://a@10.0.0.1:554/x', name: '  ', mode: 'append' });
    assert.equal(parseCameras(b.text)[0].name, '카메라 1');
});

test('saveCameraLine: 백업을 만들고 임시 파일을 남기지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    fs.writeFileSync(file, SAMPLE, 'utf8');
    const r = saveCameraLine(file, { url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.index, 2);
    assert.equal(r.backup, file + '.bak');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), SAMPLE);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 3);
    assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('saveCameraLine: 파일이 없으면 새로 만든다 (백업 없음)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    const r = saveCameraLine(file, { url: 'rtsp://a@192.168.0.5:554/x', name: '주방', mode: 'append' });
    assert.equal(r.backup, null);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 1);
});
