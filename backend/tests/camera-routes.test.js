'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { registerFinderRoutes } = require('../finder/routes');
const { AuthBudget } = require('../finder/guard');
const { parseCameras } = require('../finder/cctv-file');

const TWO = '# c\r\nrtsp://admin:secret@192.168.0.5:554/x, 거실\r\nrtsp://admin:pa%23s@192.168.0.6:554/live/ch1, 안방';

/** 호출을 기록하는 가짜 StreamManager */
function fakeStreams() {
    const calls = [];
    return {
        calls,
        fail: false,
        gate: null,
        async add(url) { calls.push(['add', url]); if (this.gate) await this.gate; if (this.fail) throw new Error('x'); return 9; },
        async restart(index, url) { calls.push(['restart', index, url]); if (this.fail) throw new Error('x'); },
        async remove(index) { calls.push(['remove', index]); if (this.fail) throw new Error('x'); },
        streamUrl(index) { return `/hls/stream${index + 7}/stream${index + 7}.m3u8`; },
    };
}

async function startApp({ deps = {}, cctvText = TWO, noFile = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-cam-'));
    const cctvPath = path.join(dir, 'cctv.txt');
    if (!noFile) fs.writeFileSync(cctvPath, cctvText, 'utf8');
    const streams = fakeStreams();
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    const authMiddleware = (req, res, next) => (req.headers['x-test-auth'] === 'ok' ? next() : res.redirect('/login'));
    registerFinderRoutes(app, { authMiddleware, baseDir: dir, cctvPath, streams, deps, budget: new AuthBudget() });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    const call = async (method, url, body, auth = true) => {
        const res = await fetch(base + url, {
            method,
            redirect: 'manual',
            headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-auth': 'ok' } : {}), ...(cookie ? { cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return res;
    };
    const read = () => fs.readFileSync(cctvPath, 'utf8');
    const cams = () => parseCameras(read());
    return { call, cctvPath, streams, read, cams, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) };
}

const found = url => ({ status: 'found', candidates: [{ url, label: 'main' }], tried: [], diagnostics: 'diag' });

test('로그인하지 않으면 /api/cameras 계열과 get-channel-list 가 막힌다', async () => {
    const app = await startApp();
    try {
        for (const [m, u] of [['GET', '/api/get-channel-list'], ['GET', '/api/cameras'], ['POST', '/api/cameras'],
            ['POST', '/api/cameras/0/edit'], ['POST', '/api/cameras/0/edit/confirm'], ['DELETE', '/api/cameras/0']]) {
            const res = await app.call(m, u, m === 'GET' ? undefined : {}, false);
            assert.equal(res.status, 302, `${m} ${u}`);
        }
    } finally { await app.close(); }
});

test('옛 /api/finder/cameras, /api/finder/save 는 없다', async () => {
    const app = await startApp();
    try {
        assert.equal((await app.call('GET', '/api/finder/cameras')).status, 404);
        assert.equal((await app.call('POST', '/api/finder/save', {})).status, 404);
    } finally { await app.close(); }
});

test('get-channel-list: 이름 없는 줄은 카메라 N, url 은 streams.streamUrl 값', async () => {
    const app = await startApp({ cctvText: 'rtsp://a:b@192.168.0.5:554/x, 거실\r\nrtsp://a:b@192.168.0.6:554/y' });
    try {
        const body = await (await app.call('GET', '/api/get-channel-list')).json();
        assert.equal(body.status, 'success');
        assert.deepEqual(body.channels, [
            { name: '거실', url: '/hls/stream7/stream7.m3u8' },
            { name: '카메라 2', url: '/hls/stream8/stream8.m3u8' },
        ]);
    } finally { await app.close(); }
});

test('get-channel-list: cctv.txt 가 없거나 비어 있으면 빈 배열', async () => {
    for (const opts of [{ noFile: true }, { cctvText: '' }]) {
        const app = await startApp(opts);
        try {
            const res = await app.call('GET', '/api/get-channel-list');
            assert.equal(res.status, 200);
            assert.deepEqual((await res.json()).channels, []);
        } finally { await app.close(); }
    }
});

test('GET /api/cameras: 목록을 주고 password 와 원래 url 은 응답에 없다', async () => {
    const app = await startApp();
    try {
        const text = await (await app.call('GET', '/api/cameras')).text();
        assert.ok(!text.includes('secret') && !text.includes('pa%23s') && !text.includes('rtsp://'));
        const { cameras } = JSON.parse(text);
        assert.equal(cameras.length, 2);
        assert.deepEqual({ ...cameras[1], hash: undefined }, { index: 1, hash: undefined, name: '안방', host: '192.168.0.6', port: 554, path: '/live/ch1', username: 'admin' });
        assert.match(cameras[1].hash, /^[0-9a-f]{16}$/);
    } finally { await app.close(); }
});

test('POST /api/cameras: 추가하면 파일 맨 뒤에 붙고 streams.add 가 그 url 로 호출된다', async () => {
    const app = await startApp();
    try {
        const res = await app.call('POST', '/api/cameras', { url: 'rtsp://admin:pw%241@192.168.0.9:554/live', name: '주방' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'success', index: 2, applied: true });
        assert.equal(app.cams()[2].url, 'rtsp://admin:pw%241@192.168.0.9:554/live');
        assert.equal(app.cams()[2].name, '주방');
        assert.deepEqual(app.streams.calls, [['add', 'rtsp://admin:pw%241@192.168.0.9:554/live']]);
        assert.ok(fs.existsSync(app.cctvPath + '.bak'));
    } finally { await app.close(); }
});

test('POST /api/cameras: 같은 host/port/path 는 409 이고 streams.add 는 호출되지 않는다', async () => {
    const app = await startApp();
    const before = app.read();
    try {
        const res = await app.call('POST', '/api/cameras', { url: 'rtsp://other:pw@192.168.0.5:554/x', name: 'n' });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).message, '이미 등록된 카메라입니다.');
        assert.deepEqual(app.streams.calls, []);
        assert.equal(app.read(), before);
    } finally { await app.close(); }
});

test('POST /api/cameras: 잘못된 주소는 400 이고 파일은 그대로, & 와 경로 쪽 @ 는 허용', async () => {
    const app = await startApp();
    const before = app.read();
    try {
        for (const url of [
            'rtsp://a:b@8.8.8.8:554/x', 'http://192.168.0.9/x', 'rtsp://a:b@192.168.0.9:554/x,evil', 'rtsp://a:b@192.168.0.9:554/x y',
            'not a url', 'rtsp://a:b@192.168.0.9:554/x"y', 'rtsp://a:b@192.168.0.9:554/x^y', 'rtsp://a:b@192.168.0.9:554/x<y',
            'rtsp://a:b@192.168.0.9:554/x>y', 'rtsp://a:b@192.168.0.9:554/x|y', 'rtsp://a:b@192.168.0.9:554/x\x01y',
            'rtsp://a:b@192.168.0.9:554/x\x7fy', 'rtsp://x@8.8.8.8:1@192.168.0.5/live', 'rtsp://a:b@c@192.168.0.5:554/live', 123,
        ]) {
            const res = await app.call('POST', '/api/cameras', { url, name: 'n' });
            assert.equal(res.status, 400, JSON.stringify(url));
        }
        assert.equal(app.read(), before);
        assert.equal((await app.call('POST', '/api/cameras', { url: 'rtsp://a:b@192.168.0.9:554/cam/realmonitor?channel=1&subtype=0', name: 'n' })).status, 200);
        assert.equal((await app.call('POST', '/api/cameras', { url: 'rtsp://a:b@192.168.0.9:554/x@y', name: 'n2' })).status, 200);
    } finally { await app.close(); }
});

test('POST /api/cameras: streams.add 가 throw 해도 저장은 되고 applied:false', async () => {
    const app = await startApp();
    app.streams.fail = true;
    try {
        const res = await app.call('POST', '/api/cameras', { url: 'rtsp://a:b@192.168.0.9:554/z', name: 'n' });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).applied, false);
        assert.equal(app.cams().length, 3);
    } finally { await app.close(); }
});

test('edit: 이름만 바꾸면 findStream 과 streams 를 호출하지 않는다', async () => {
    let called = 0;
    const app = await startApp({ deps: { findStream: async () => { called++; return found('rtsp://x'); } } });
    try {
        const cam = app.cams()[0];
        const res = await app.call('POST', '/api/cameras/0/edit', { hash: cam.hash, name: '큰 거실', username: 'admin', password: '' });
        assert.deepEqual(await res.json(), { status: 'saved', applied: true });
        assert.equal(called, 0);
        assert.deepEqual(app.streams.calls, []);
        assert.equal(app.cams()[0].name, '큰 거실');
        assert.equal(app.cams()[0].url, cam.url);
    } finally { await app.close(); }
});

test('edit: 비밀번호를 비우면 기존 비밀번호로 기존 포트/경로를 먼저 시도한다', async () => {
    const seen = [];
    const app = await startApp({ deps: { findStream: async a => { seen.push(a); return found('rtsp://admin2:pa%23s@192.168.0.6:554/live/ch1'); } } });
    try {
        const cam = app.cams()[1];
        await app.call('POST', '/api/cameras/1/edit', { hash: cam.hash, name: '안방', username: 'admin2', password: '' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].password, 'pa#s');
        assert.equal(seen[0].username, 'admin2');
        assert.equal(seen[0].host, '192.168.0.6');
        assert.equal(seen[0].port, 554);
        assert.equal(seen[0].path, '/live/ch1');
        assert.ok(seen[0].budget && seen[0].settings);
    } finally { await app.close(); }
});

test('edit: 기존 경로로 1번 시도하고 path_not_found 일 때만 전체 탐색한다', async () => {
    const seen = [];
    const app = await startApp({ deps: { findStream: async a => { seen.push(a.path); return { status: 'auth_failed', tried: [], diagnostics: 'd' }; } } });
    try {
        const cam = app.cams()[0];
        const res = await app.call('POST', '/api/cameras/0/edit', { hash: cam.hash, name: '거실', username: 'admin', password: 'wrong' });
        const body = await res.json();
        assert.equal(body.status, 'auth_failed');
        assert.equal(body.diagnostics, 'd');
        assert.deepEqual(seen, ['/x']);
        assert.deepEqual(app.streams.calls, []);
    } finally { await app.close(); }

    const seen2 = [];
    const app2 = await startApp({
        deps: { findStream: async a => { seen2.push(a.path); return a.path ? { status: 'path_not_found', tried: [], diagnostics: '' } : found('rtsp://admin:new@192.168.0.5:554/y'); } },
    });
    try {
        const cam = app2.cams()[0];
        const body = await (await app2.call('POST', '/api/cameras/0/edit', { hash: cam.hash, name: '거실', username: 'admin', password: 'new' })).json();
        assert.equal(body.status, 'saved');
        assert.deepEqual(seen2, ['/x', undefined]);
    } finally { await app2.close(); }
});

test('edit: 성공하면 같은 순번 줄만 바뀌고 streams.restart(index, 새 url)', async () => {
    const app = await startApp({ deps: { findStream: async () => found('rtsp://admin:new@192.168.0.5:554/x') } });
    try {
        const before = app.cams();
        const res = await app.call('POST', '/api/cameras/0/edit', { hash: before[0].hash, name: '새 거실', username: 'admin', password: 'new' });
        assert.deepEqual(await res.json(), { status: 'saved', applied: true });
        const after = app.cams();
        assert.equal(after[0].url, 'rtsp://admin:new@192.168.0.5:554/x');
        assert.equal(after[0].name, '새 거실');
        assert.equal(after[1].raw, before[1].raw);
        assert.deepEqual(app.streams.calls, [['restart', 0, 'rtsp://admin:new@192.168.0.5:554/x']]);
    } finally { await app.close(); }
});

test('edit: 다른 IP 의 주소가 돌아오면 저장하지 않는다', async () => {
    const app = await startApp({ deps: { findStream: async () => found('rtsp://admin:new@192.168.0.99:554/x') } });
    const before = app.read();
    try {
        const cam = app.cams()[0];
        const res = await app.call('POST', '/api/cameras/0/edit', { hash: cam.hash, name: '거실', username: 'admin', password: 'new' });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).message, '찾은 주소가 이 카메라와 맞지 않습니다.');
        assert.equal(app.read(), before);
        assert.deepEqual(app.streams.calls, []);
    } finally { await app.close(); }
});

test('edit: 후보가 여러 개면 choose 를 주고 confirm 으로 저장한다', async () => {
    const app = await startApp({
        deps: {
            findStream: async a => (a.path ? { status: 'path_not_found', tried: [], diagnostics: '' } : {
                status: 'found', tried: [], diagnostics: '',
                candidates: [
                    { url: 'rtsp://admin:newpw@192.168.0.5:554/main', label: '메인' },
                    { url: 'rtsp://admin:newpw@192.168.0.5:554/x', label: '서브' },
                ],
            }),
        },
    });
    try {
        const cam = app.cams()[0];
        const res = await app.call('POST', '/api/cameras/0/edit', { hash: cam.hash, name: '거실2', username: 'admin', password: 'newpw' });
        const text = await res.text();
        assert.ok(!text.includes('newpw'));
        const body = JSON.parse(text);
        assert.equal(body.status, 'choose');
        assert.equal(body.preselect, 1);   // 기존 경로(/x)와 같은 후보
        assert.deepEqual(body.candidates.map(c => c.label), ['메인', '서브']);
        assert.equal(body.candidates[0].maskedUrl, 'rtsp://admin:****@192.168.0.5:554/main');
        assert.deepEqual(app.streams.calls, []);

        const ok = await app.call('POST', '/api/cameras/0/edit/confirm', { hash: cam.hash, choice: 0 });
        assert.deepEqual(await ok.json(), { status: 'saved', applied: true });
        assert.equal(app.cams()[0].url, 'rtsp://admin:newpw@192.168.0.5:554/main');
        assert.equal(app.cams()[0].name, '거실2');
        assert.deepEqual(app.streams.calls, [['restart', 0, 'rtsp://admin:newpw@192.168.0.5:554/main']]);

        // 한 번 쓰면 다시 쓸 수 없다
        assert.equal((await app.call('POST', '/api/cameras/0/edit/confirm', { hash: app.cams()[0].hash, choice: 0 })).status, 409);
    } finally { await app.close(); }
});

test('edit/delete: hash 가 다르면 409 이고 파일과 streams 는 그대로', async () => {
    const app = await startApp({ deps: { findStream: async () => found('rtsp://admin:new@192.168.0.5:554/x') } });
    const before = app.read();
    try {
        const wrong = app.cams()[1].hash;
        for (const [m, u, b] of [
            ['POST', '/api/cameras/0/edit', { hash: wrong, name: 'n', username: 'admin', password: '' }],
            ['POST', '/api/cameras/0/edit', { hash: wrong, name: 'n', username: 'admin', password: 'new' }],
            ['DELETE', '/api/cameras/0', { hash: wrong }],
            ['DELETE', '/api/cameras/5', { hash: wrong }],
        ]) {
            const res = await app.call(m, u, b);
            assert.equal(res.status, 409, `${m} ${u} ${JSON.stringify(b)}`);
        }
        assert.equal(app.read(), before);
        assert.deepEqual(app.streams.calls, []);
    } finally { await app.close(); }
});

test('delete: 그 줄만 지우고 streams.remove(index)', async () => {
    const app = await startApp();
    try {
        const cams = app.cams();
        const res = await app.call('DELETE', '/api/cameras/0', { hash: cams[0].hash });
        assert.deepEqual(await res.json(), { status: 'success', applied: true });
        assert.deepEqual(app.cams().map(c => c.raw), [cams[1].raw]);
        assert.ok(app.read().startsWith('# c'));
        assert.deepEqual(app.streams.calls, [['remove', 0]]);
    } finally { await app.close(); }
});

test('동시 쓰기: 잠금 중이면 409', async () => {
    const app = await startApp();
    let release;
    app.streams.gate = new Promise(r => { release = r; });
    try {
        const first = app.call('POST', '/api/cameras', { url: 'rtsp://a:b@192.168.0.9:554/z', name: 'n' });
        await new Promise(r => setTimeout(r, 50));
        const cam = app.cams()[0];
        const second = await app.call('DELETE', '/api/cameras/0', { hash: cam.hash });
        assert.equal(second.status, 409);
        assert.equal((await second.json()).message, '다른 변경을 처리 중입니다. 잠시 후 다시 시도하세요.');
        release();
        assert.equal((await first).status, 200);
        assert.equal(app.cams().length, 3);
    } finally { release(); await app.close(); }
});

test('probe rtspUrl: 주소의 계정보다 본문 계정이 우선하고, 특수문자 비밀번호는 인코딩이 한 번만 된다', async () => {
    const seen = [];
    const app = await startApp({ deps: { findStream: async a => { seen.push(a); return found('rtsp://x'); } } });
    try {
        await app.call('POST', '/api/finder/probe', { rtspUrl: 'rtsp://u1:p%23w@192.168.0.7:8554/Streaming/Channels/201' });
        assert.equal(seen[0].host, '192.168.0.7');
        assert.equal(seen[0].port, 8554);
        assert.equal(seen[0].path, '/Streaming/Channels/201');
        assert.equal(seen[0].username, 'u1');
        assert.equal(seen[0].password, 'p#w');

        await app.call('POST', '/api/finder/probe', { rtspUrl: 'rtsp://u1:p1@192.168.0.7/live', username: 'u2', password: 'a@b:c#' });
        assert.equal(seen[1].username, 'u2');
        assert.equal(seen[1].password, 'a@b:c#');
        assert.equal(seen[1].port, 554);

        const bad = await app.call('POST', '/api/finder/probe', { rtspUrl: 'http://192.168.0.7/live' });
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).message, 'RTSP 주소 형식이 올바르지 않습니다.');
        const pub = await app.call('POST', '/api/finder/probe', { rtspUrl: 'rtsp://8.8.8.8/live' });
        assert.equal(pub.status, 400);
        assert.equal(seen.length, 2);
    } finally { await app.close(); }
});
