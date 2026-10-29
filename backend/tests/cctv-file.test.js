'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeCred, buildRtspUrl, parseCameras, parseRtspUrl, sameStream, applyEdit, saveCameras } = require('../finder/cctv-file');

const SAMPLE = [
    '# [CCTV 연결 설정 가이드]',
    '',
    '# ↓ 아래에 카메라 정보를 입력하세요',
    'rtsp://admin:start%244962@192.168.219.100:554/Streaming/Channels/101, 거실',
    'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1, 안방',
].join('\r\n');

const THREE = [
    '# 주석',
    'rtsp://a:b@192.168.0.1:554/x, 하나',
    'rtsp://a:b@192.168.0.2:554/y, 둘',
    '# 가운데 주석',
    'rtsp://a:b@192.168.0.3:554/z, 셋',
].join('\r\n');

function codeOf(fn) {
    try { fn(); } catch (e) { return e.code; }
    return null;
}

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
    assert.equal(cams[1].index, 1);
    assert.equal(cams[1].url, 'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1');
    assert.equal(cams[1].name, '안방');
    assert.equal(cams[1].raw, 'rtsp://admin:dash1101%21@192.168.219.194:554/onvif1, 안방');
});

test('parseCameras: BOM과 앞 공백 주석을 주석으로 본다', () => {
    const cams = parseCameras('\uFEFF# a\r\n  # b\r\nrtsp://u:p@192.168.0.5:554/x, 거실\nrtsp://u:p@192.168.0.6:554/y');
    assert.equal(cams.length, 2);
    assert.equal(cams[0].name, '거실');
    assert.equal(cams[1].name, '');
    assert.equal(cams[1].index, 1);
    // BOM 바로 뒤가 카메라 줄이어도 주소에 BOM 이 섞이지 않는다
    assert.equal(parseCameras('\uFEFFrtsp://u:p@192.168.0.5:554/x, 거실')[0].url, 'rtsp://u:p@192.168.0.5:554/x');
});

test('parseCameras: hash 는 같은 줄이면 같고 다르면 다르며 비밀번호가 드러나지 않는다', () => {
    const a = parseCameras('rtsp://u:secretpw@192.168.0.5:554/x, 거실')[0];
    const b = parseCameras('  rtsp://u:secretpw@192.168.0.5:554/x, 거실  ')[0];
    const c = parseCameras('rtsp://u:secretpw@192.168.0.5:554/x, 안방')[0];
    assert.match(a.hash, /^[0-9a-f]{16}$/);
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
    assert.ok(!a.hash.includes('secretpw'));
});

test('parseRtspUrl: 특수문자 비밀번호를 풀어서 돌려준다', () => {
    assert.deepEqual(parseRtspUrl('rtsp://admin:pa%23s%40%3A%21@192.168.0.5/Streaming/Channels/201'), {
        host: '192.168.0.5', port: 554, path: '/Streaming/Channels/201', username: 'admin', password: 'pa#s@:!',
    });
});

test('parseRtspUrl: 쿼리 포함 경로와 계정 없는 주소', () => {
    assert.deepEqual(parseRtspUrl('rtsp://192.168.0.9:8554/cam/realmonitor?channel=1&subtype=0'), {
        host: '192.168.0.9', port: 8554, path: '/cam/realmonitor?channel=1&subtype=0', username: '', password: '',
    });
    assert.equal(parseRtspUrl('rtsp://admin@192.168.0.9').path, '/');
    assert.equal(parseRtspUrl('rtsp://admin@192.168.0.9').username, 'admin');
    assert.equal(parseRtspUrl('http://x'), null);
    assert.equal(parseRtspUrl('rtsp://'), null);
    assert.equal(parseRtspUrl(''), null);
});

test('왕복: buildRtspUrl(parseRtspUrl(u)) 는 인코딩이 한 번만 적용된다', () => {
    const parsed = parseRtspUrl('rtsp://admin:pa%23s%40%3A%21@192.168.0.5/Streaming/Channels/201');
    const again = parseRtspUrl(buildRtspUrl(parsed));
    assert.equal(again.password, 'pa#s@:!');
    assert.equal(again.path, '/Streaming/Channels/201');
});

test('sameStream: host/port/path 가 같으면 계정이 달라도 같은 카메라', () => {
    assert.equal(sameStream('rtsp://a:b@192.168.0.5:554/x', 'rtsp://c:d@192.168.0.5/x'), true);
    assert.equal(sameStream('rtsp://a:b@192.168.0.5:554/x', 'rtsp://a:b@192.168.0.5:554/X'), false);
    assert.equal(sameStream('rtsp://a:b@192.168.0.5:554/x', 'rtsp://a:b@192.168.0.5:8554/x'), false);
    assert.equal(sameStream('rtsp://a:b@192.168.0.5:554/x', 'garbage'), false);
});

test('applyEdit append: 주석을 보존하고 CRLF로 끝에 추가한다', () => {
    const r = applyEdit(SAMPLE, { type: 'append', url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방' });
    assert.equal(r.index, 2);
    assert.ok(r.text.startsWith('# [CCTV 연결 설정 가이드]\r\n\r\n# ↓'));
    assert.ok(r.text.endsWith('안방\r\nrtsp://a:b@192.168.0.5:554/x, 주방\r\n'));
    assert.equal(parseCameras(r.text).length, 3);
});

test('applyEdit append: LF 파일은 LF를 유지하고 빈 파일은 CRLF', () => {
    const lf = applyEdit('# c\nrtsp://a:b@10.0.0.1:554/x, 1\n', { type: 'append', url: 'rtsp://a:b@10.0.0.2:554/y', name: '2' });
    assert.equal(lf.text, '# c\nrtsp://a:b@10.0.0.1:554/x, 1\nrtsp://a:b@10.0.0.2:554/y, 2\n');
    const empty = applyEdit('', { type: 'append', url: 'rtsp://a:b@10.0.0.2:554/y', name: '2' });
    assert.equal(empty.text, 'rtsp://a:b@10.0.0.2:554/y, 2\r\n');
});

test('applyEdit append: 같은 host/port/path 는 계정이 달라도 DUPLICATE', () => {
    assert.equal(codeOf(() => applyEdit(THREE, { type: 'append', url: 'rtsp://other:pw@192.168.0.2/y', name: 'n' })), 'DUPLICATE');
    // 같은 IP 라도 경로가 다르면 (NVR 채널 등) 추가할 수 있다
    assert.equal(applyEdit(THREE, { type: 'append', url: 'rtsp://a:b@192.168.0.2:554/y2', name: 'n' }).index, 3);
});

test('이름의 콤마/줄바꿈은 제거하고 비어 있으면 기본 이름을 쓴다', () => {
    const a = applyEdit('', { type: 'append', url: 'rtsp://a@10.0.0.1:554/x', name: '거실, 큰방\n2' });
    assert.equal(parseCameras(a.text)[0].name, '거실 큰방 2');
    const b = applyEdit('', { type: 'append', url: 'rtsp://a@10.0.0.1:554/x', name: '  ' });
    assert.equal(parseCameras(b.text)[0].name, '카메라 1');
});

test('applyEdit update: 이름만 바꾸면 url 은 그대로이고 다른 줄과 주석은 보존된다', () => {
    const cams = parseCameras(THREE);
    const r = applyEdit(THREE, { type: 'update', index: 1, hash: cams[1].hash, name: '새 이름' });
    assert.equal(r.index, 1);
    assert.equal(r.text, THREE.replace('rtsp://a:b@192.168.0.2:554/y, 둘', 'rtsp://a:b@192.168.0.2:554/y, 새 이름'));
});

test('applyEdit update: url 교체는 같은 순번 줄만 바뀐다', () => {
    const cams = parseCameras(THREE);
    const r = applyEdit(THREE, { type: 'update', index: 2, hash: cams[2].hash, url: 'rtsp://n:p@192.168.0.3:554/z2' });
    const after = parseCameras(r.text);
    assert.equal(after.length, 3);
    assert.equal(after[2].url, 'rtsp://n:p@192.168.0.3:554/z2');
    assert.equal(after[2].name, '셋');
    assert.equal(after[0].raw, cams[0].raw);
    assert.equal(after[1].raw, cams[1].raw);
    assert.ok(r.text.includes('# 가운데 주석'));
});

test('applyEdit remove: 가운데 줄을 지우면 나머지 순서와 주석이 보존된다', () => {
    const cams = parseCameras(THREE);
    const r = applyEdit(THREE, { type: 'remove', index: 1, hash: cams[1].hash });
    assert.equal(r.text, ['# 주석', 'rtsp://a:b@192.168.0.1:554/x, 하나', '# 가운데 주석', 'rtsp://a:b@192.168.0.3:554/z, 셋'].join('\r\n'));
});

test('applyEdit update/remove: hash 가 다르거나 index 가 범위 밖이면 CONFLICT', () => {
    const cams = parseCameras(THREE);
    assert.equal(codeOf(() => applyEdit(THREE, { type: 'remove', index: 1, hash: cams[0].hash })), 'CONFLICT');
    assert.equal(codeOf(() => applyEdit(THREE, { type: 'update', index: 5, hash: cams[0].hash, name: 'x' })), 'CONFLICT');
    assert.equal(codeOf(() => applyEdit(THREE, { type: 'update', index: -1, hash: cams[0].hash, name: 'x' })), 'CONFLICT');
    assert.equal(codeOf(() => applyEdit(THREE, { type: 'remove', index: '1', hash: cams[1].hash })), 'CONFLICT');
});

test('saveCameras: 백업을 만들고 임시 파일을 남기지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    fs.writeFileSync(file, SAMPLE, 'utf8');
    const r = saveCameras(file, { type: 'append', url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방' });
    assert.equal(r.index, 2);
    assert.equal(r.backup, file + '.bak');
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), SAMPLE);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 3);
    assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('saveCameras: 파일이 없으면 새로 만든다 (백업 없음)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    const r = saveCameras(file, { type: 'append', url: 'rtsp://a@192.168.0.5:554/x', name: '주방' });
    assert.equal(r.backup, null);
    assert.equal(parseCameras(fs.readFileSync(file, 'utf8')).length, 1);
});

test('saveCameras: 쓰기에 실패하면 원본은 그대로 남는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    fs.writeFileSync(file, SAMPLE, 'utf8');
    fs.mkdirSync(file + '.tmp');   // 임시 파일 자리에 폴더가 있으면 쓰기가 실패한다
    assert.throws(() => saveCameras(file, { type: 'append', url: 'rtsp://a:b@192.168.0.5:554/x', name: '주방' }));
    assert.equal(fs.readFileSync(file, 'utf8'), SAMPLE);
});

test('saveCameras: CONFLICT 면 파일과 백업을 건드리지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-'));
    const file = path.join(dir, 'cctv.txt');
    fs.writeFileSync(file, THREE, 'utf8');
    assert.throws(() => saveCameras(file, { type: 'remove', index: 0, hash: 'deadbeefdeadbeef' }), e => e.code === 'CONFLICT');
    assert.equal(fs.readFileSync(file, 'utf8'), THREE);
    assert.equal(fs.existsSync(file + '.bak'), false);
});
