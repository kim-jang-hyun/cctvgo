'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { createZip, tailText, camerasSummary, buildBundle } = require('../diagnostics/bundle');
const { registerDiagRoutes } = require('../diagnostics/routes');

/** 테스트용 zip 읽기: 중앙 디렉터리를 따라 { 이름: 내용(Buffer) } 를 돌려준다. CRC 도 확인한다 */
function readZip(buf) {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(eocd >= 0, 'EOCD 없음');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const out = {};
    for (let i = 0; i < count; i++) {
        assert.equal(buf.readUInt32LE(off), 0x02014b50);
        const method = buf.readUInt16LE(off + 10);
        const crc = buf.readUInt32LE(off + 16);
        const csize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const local = buf.readUInt32LE(off + 42);
        const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
        const lNameLen = buf.readUInt16LE(local + 26);
        const lExtraLen = buf.readUInt16LE(local + 28);
        const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
        const content = method === 8 ? zlib.inflateRawSync(data) : data;
        assert.equal(zlib.crc32 ? zlib.crc32(content) >>> 0 : crc, crc, `${name} CRC`);
        out[name] = content;
        off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

test('createZip: 한글 이름과 내용이 그대로 풀리는 zip 을 만든다', () => {
    const zip = createZip([{ name: '요약.txt', data: '안녕 CCTVGO\n' }, { name: 'logs/a.log', data: Buffer.from('x'.repeat(5000)) }]);
    const files = readZip(zip);
    assert.equal(files['요약.txt'].toString('utf8'), '안녕 CCTVGO\n');
    assert.equal(files['logs/a.log'].length, 5000);
});

test('tailText: 크면 마지막 부분만 남기고 앞부분 생략을 알린다 (줄 중간에서 자르지 않음)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n';
    assert.equal(tailText(Buffer.from(text), 10000).toString(), text);
    const t = tailText(Buffer.from(text), 50).toString();
    assert.match(t, /^\[앞부분 생략: \d+바이트\]\n/);
    assert.ok(t.endsWith('line99\n'));
    assert.ok(!/\nine/.test(t), '줄 중간에서 시작하지 않음');
});

test('camerasSummary: 카메라 목록에서 아이디/비밀번호를 빼고 주소·이름·서브 유무만 남긴다', () => {
    const s = camerasSummary('# 주석\nrtsp://admin:dash1101%21@192.168.219.103:554/onvif1, 안방, rtsp://admin:dash1101%21@192.168.219.103:554/onvif2\r\nrtsp://a:b@192.168.0.5:554/x\n');
    assert.match(s, /1\. 안방 \| 192\.168\.219\.103:554\/onvif1 \| 서브: 192\.168\.219\.103:554\/onvif2/);
    assert.match(s, /2\. \(이름 없음\) \| 192\.168\.0\.5:554\/x \| 서브: 없음/);
    assert.ok(!s.includes('dash1101'));
    assert.ok(!s.includes('admin'));
});

function setupInstall() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-bundle-'));
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'service.log'), 'ok\nERR url=rtsp://admin:secret@192.168.0.5:554/x\n');
    fs.writeFileSync(path.join(logDir, 'connections.log'), '{"k":1}\n');
    fs.writeFileSync(path.join(logDir, 'big.log'), 'y'.repeat(3000) + '\n' + 'last line\n');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"password":"loginpw"}');
    fs.writeFileSync(path.join(dir, 'cctv.txt'), 'rtsp://admin:secret@192.168.0.5:554/x, 거실\n');
    return { dir, logDir };
}

test('buildBundle: 요약·PC 정보·카메라·go2rtc 상태·로그를 넣고, 비밀번호는 어디에도 남지 않는다', async () => {
    const { dir, logDir } = setupInstall();
    const entries = await buildBundle({
        logDir, cctvPath: path.join(dir, 'cctv.txt'),
        diagText: () => '진단 요약 rtsp://u:p@h/x',
        systemInfo: async () => 'Windows 11\nCPU i5',
        go2rtcStreams: async () => ({ cctvgo_k1: { producers: [{ url: 'rtsp://admin:secret@192.168.0.5:554/x' }] } }),
        info: { version: '1.0.0', encoder: 'h264_qsv' },
        maxFileBytes: 1000, maxTotalBytes: 1e6,
    });
    const names = entries.map(e => e.name);
    for (const n of ['요약.txt', 'PC정보.txt', '카메라.txt', 'go2rtc-상태.json', 'logs/service.log', 'logs/connections.log', 'logs/big.log']) {
        assert.ok(names.includes(n), n);
    }
    assert.ok(!names.some(n => /config\.json|go2rtc\.yaml|cctv\.txt/.test(n)), '비밀번호가 든 원본 파일은 넣지 않음');
    const all = entries.map(e => Buffer.from(e.data).toString('utf8')).join('\n');
    assert.ok(!all.includes('secret'));
    assert.ok(!all.includes('u:p@'));
    assert.ok(!all.includes('loginpw'));
    assert.match(all, /h264_qsv/);
    const big = entries.find(e => e.name === 'logs/big.log').data.toString();
    assert.match(big, /^\[앞부분 생략/);
    assert.ok(big.endsWith('last line\n'));
});

test('buildBundle: 전체 한도를 넘으면 나머지 로그는 넣지 않고 그 사실을 남긴다', async () => {
    const { dir, logDir } = setupInstall();
    const entries = await buildBundle({
        logDir, cctvPath: path.join(dir, 'cctv.txt'), diagText: () => 'x', systemInfo: async () => 'x', go2rtcStreams: async () => ({}),
        info: {}, maxFileBytes: 10000, maxTotalBytes: 200,
    });
    const note = entries.find(e => e.name === '빠진-파일.txt');
    assert.ok(note, '빠진 파일 안내');
    assert.match(note.data.toString(), /logs\//);
});

test('buildBundle: PC 정보나 go2rtc 상태를 못 얻어도 나머지는 만든다', async () => {
    const { dir, logDir } = setupInstall();
    const entries = await buildBundle({
        logDir, cctvPath: path.join(dir, 'cctv.txt'), diagText: () => 'x',
        systemInfo: async () => { throw new Error('powershell 없음'); },
        go2rtcStreams: async () => { throw new Error('go2rtc 꺼짐'); },
        info: {}, maxFileBytes: 10000, maxTotalBytes: 1e6,
    });
    assert.match(entries.find(e => e.name === 'PC정보.txt').data.toString(), /powershell 없음/);
    assert.match(entries.find(e => e.name === 'go2rtc-상태.json').data.toString(), /go2rtc 꺼짐/);
    assert.ok(entries.some(e => e.name === 'logs/service.log'));
});

test('GET /api/diagnostics/bundle: 로그인해야 받고, zip 파일로 내려준다', async () => {
    const app = express();
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerDiagRoutes(app, { authMiddleware, diag: { text: () => 't', connection() {} }, bundle: async () => [{ name: '요약.txt', data: 'hello' }] });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(base + '/api/diagnostics/bundle', { redirect: 'manual' })).status, 302);
        const res = await fetch(base + '/api/diagnostics/bundle', { headers: { 'x-test-auth': 'ok' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.match(res.headers.get('content-disposition'), /^attachment; filename="cctvgo-diagnostics-\d{8}-\d{4}\.zip"$/);
        const files = readZip(Buffer.from(await res.arrayBuffer()));
        assert.equal(files['요약.txt'].toString(), 'hello');
    } finally { await new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }); }
});
