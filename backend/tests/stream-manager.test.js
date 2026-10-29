'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamManager } = require('../streams/stream-manager');
const real = require('../streams/processes');

/** 실제 프로세스 대신 호출을 기록하는 가짜. 실행 중인 프로세스 목록은 running 으로 흉내 낸다 */
function fakeProcs(scriptDir) {
    const calls = { spawned: [], killed: [] };
    let nextPid = 100;
    const running = [];
    const procs = {
        matchesStream: real.matchesStream,
        isOurStreamProcess: real.isOurStreamProcess,
        listFail: false,
        spawnFail: false,
        listGate: null,
        async listProcesses() {
            if (this.listGate) await this.listGate;
            if (this.listFail) throw new Error('powershell 실패');
            return running.map(p => ({ ...p }));
        },
        async killTree(pid) {
            calls.killed.push(pid);
            for (let i = running.length - 1; i >= 0; i--) if (running[i].pid === pid) running.splice(i, 1);
        },
        spawnStream({ k, url }) {
            if (this.spawnFail) throw new Error('spawn 실패');
            calls.spawned.push({ k, url });
            running.push({ pid: nextPid++, commandLine: `cmd /c "${scriptDir}\\run_single_stream.bat "hls\\stream${k}" "stream${k}.m3u8" "5""` });
            running.push({ pid: nextPid++, commandLine: `${scriptDir}\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -i ${url} -f hls hls\\stream${k}\\stream${k}.m3u8` });
        },
    };
    return { procs, calls, running };
}

function setup(extraRunning = () => []) {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-sm-'));
    const f = fakeProcs(scriptDir);
    f.running.push(...extraRunning(scriptDir));
    const logs = [];
    const mgr = new StreamManager({ scriptDir, procs: f.procs, log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) });
    return { mgr, scriptDir, logs, ...f };
}

const [A, B, C, D] = ['rtsp://a:secret@192.168.0.1:554/x', 'rtsp://a:secret@192.168.0.2:554/y', 'rtsp://a:secret@192.168.0.3:554/z', 'rtsp://a:secret@192.168.0.4:554/w'];
const pidsOf = (running, k) => running.filter(p => new RegExp(`stream${k}\\.m3u8`).test(p.commandLine)).map(p => p.pid).sort();

test('startAll: 우리 프로세스만 정리하고 hls 를 비운 뒤 1..N 으로 켠다', async () => {
    const { mgr, scriptDir, calls } = setup(dir => [
        { pid: 1, commandLine: `${dir}\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -i x -f hls hls\\stream1\\stream1.m3u8` },
        { pid: 2, commandLine: 'C:\\other\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -f hls hls\\stream1\\stream1.m3u8' },
        { pid: 3, commandLine: 'cmd /c notepad.exe' },
    ]);
    fs.mkdirSync(path.join(scriptDir, 'hls', 'stream9'), { recursive: true });
    await mgr.startAll([A, B, C]);
    assert.deepEqual(calls.killed, [1]);
    assert.equal(fs.existsSync(path.join(scriptDir, 'hls', 'stream9')), false);
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2, 3]);
    assert.deepEqual(mgr.streamUrls([A, B, C]), ['/hls/stream1/stream1.m3u8', '/hls/stream2/stream2.m3u8', '/hls/stream3/stream3.m3u8']);
});

test('remove 후 add: 번호를 재사용하지 않고 다른 카메라 번호는 그대로', async () => {
    const { mgr, calls } = setup();
    await mgr.startAll([A, B, C]);
    await mgr.remove(A);
    assert.deepEqual(mgr.streamUrls([B, C]), ['/hls/stream2/stream2.m3u8', '/hls/stream3/stream3.m3u8']);
    const k = await mgr.add(D);
    assert.equal(k, 4);
    assert.deepEqual(mgr.streamUrls([B, C, D]).at(-1), '/hls/stream4/stream4.m3u8');
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2, 3, 4]);
});

test('remove: 그 카메라 프로세스만 종료한다', async () => {
    const { mgr, calls, running } = setup();
    await mgr.startAll([A, B, C]);
    const target = pidsOf(running, 2);
    await mgr.remove(B);
    assert.deepEqual(calls.killed.sort(), target);
});

test('restart: 같은 번호로 끄고 켜며 다른 번호 프로세스는 건드리지 않는다', async () => {
    const { mgr, calls, running } = setup();
    await mgr.startAll([A, B, C]);
    const target = pidsOf(running, 2);
    const B2 = 'rtsp://n:p@192.168.0.2:554/y2';
    await mgr.restart(B, B2);
    assert.deepEqual(calls.killed.sort(), target);
    assert.deepEqual(calls.spawned.at(-1), { k: 2, url: B2 });
    assert.deepEqual(mgr.streamUrls([A, B2, C]), ['/hls/stream1/stream1.m3u8', '/hls/stream2/stream2.m3u8', '/hls/stream3/stream3.m3u8']);
});

test('stop 순서: run_single_stream cmd 를 ffmpeg 보다 먼저 종료한다', async () => {
    const { mgr, calls, running } = setup();
    await mgr.startAll([A, B, C]);
    // 목록에서 ffmpeg 가 먼저 나와도 루프 cmd 를 먼저 끈다 (안 그러면 루프가 ffmpeg 를 다시 띄운다)
    running.reverse();
    const loop = running.find(p => /run_single_stream/.test(p.commandLine) && /stream1\.m3u8/.test(p.commandLine)).pid;
    await mgr.remove(A);
    assert.equal(calls.killed[0], loop);
});

test('모르는 주소의 remove 는 아무 프로세스도 건드리지 않고, restart 는 새로 켠다', async () => {
    const { mgr, calls } = setup();
    await mgr.startAll([A, B]);
    await mgr.remove('rtsp://x@192.168.0.9/q');
    assert.deepEqual(calls.killed, []);
    await mgr.restart('rtsp://x@192.168.0.9/q', D);
    assert.deepEqual(calls.killed, []);
    assert.deepEqual(calls.spawned.at(-1), { k: 3, url: D });
});

test('remove 중 프로세스 조회가 실패해도 대응표는 파일과 같게 바뀌고, 이후 작업이 다른 카메라를 끄지 않는다', async () => {
    const { mgr, procs, calls, running } = setup();
    await mgr.startAll([A, B, C]);
    procs.listFail = true;
    await assert.rejects(() => mgr.remove(B));
    procs.listFail = false;
    // 파일은 [A, C]: C 는 여전히 자기 영상(stream3)을 가리킨다
    assert.deepEqual(mgr.streamUrls([A, C]), ['/hls/stream1/stream1.m3u8', '/hls/stream3/stream3.m3u8']);
    const cPids = pidsOf(running, 3);
    calls.killed.length = 0;
    await mgr.remove(C);
    assert.deepEqual(calls.killed.sort(), cPids);
});

test('add 에서 실행이 실패해도 대응표에는 남아 이후 번호가 어긋나지 않는다', async () => {
    const { mgr, procs } = setup();
    await mgr.startAll([A]);
    procs.spawnFail = true;
    await assert.rejects(() => mgr.add(B));
    procs.spawnFail = false;
    await mgr.add(C);
    assert.deepEqual(mgr.streamUrls([A, B, C]), ['/hls/stream1/stream1.m3u8', '/hls/stream2/stream2.m3u8', '/hls/stream3/stream3.m3u8']);
});

test('cctv.txt 를 직접 고쳐 순서가 달라도 주소로 영상을 찾고, 모르는 줄은 null', async () => {
    const { mgr } = setup();
    await mgr.startAll([A, B, C]);
    assert.deepEqual(mgr.streamUrls([C, 'rtsp://new@192.168.0.8/n', A]), ['/hls/stream3/stream3.m3u8', null, '/hls/stream1/stream1.m3u8']);
});

test('같은 주소 줄이 두 개면 각각 다른 영상에 짝지어진다', async () => {
    const { mgr } = setup();
    await mgr.startAll([A, A]);
    assert.deepEqual(mgr.streamUrls([A, A]), ['/hls/stream1/stream1.m3u8', '/hls/stream2/stream2.m3u8']);
});

test('startAll 이 끝나기 전에 온 add 는 startAll 뒤에 실행된다', async () => {
    const { mgr, procs, calls } = setup();
    let release;
    procs.listGate = new Promise(r => { release = r; });
    const starting = mgr.startAll([A, B]);
    const adding = mgr.add(C);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(calls.spawned, []);
    procs.listGate = null;
    release();
    await starting;
    assert.equal(await adding, 3);
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2, 3]);
    assert.deepEqual(mgr.streamUrls([A, B, C]).at(-1), '/hls/stream3/stream3.m3u8');
});

test('startAll: 정리 단계가 실패해도 영상은 켠다', async () => {
    const { mgr, procs, calls } = setup();
    procs.listFail = true;
    await mgr.startAll([A, B]);
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2]);
});

test('startAll: 한 카메라 실행이 실패해도 나머지는 켜고 번호는 유지한다', async () => {
    const { mgr, procs, calls } = setup();
    const orig = procs.spawnStream;
    procs.spawnStream = function (o) { if (o.k === 1) throw new Error('x'); return orig.call(this, o); };
    await mgr.startAll([A, B]);
    assert.deepEqual(calls.spawned.map(s => s.k), [2]);
    assert.deepEqual(mgr.streamUrls([A, B]), ['/hls/stream1/stream1.m3u8', '/hls/stream2/stream2.m3u8']);
});

test('로그에 url 이 남지 않는다', async () => {
    const { mgr, logs } = setup();
    await mgr.startAll([A, B]);
    await mgr.add(C);
    await mgr.restart(A, 'rtsp://a:secret@192.168.0.1:554/x2');
    await mgr.remove(B);
    assert.ok(logs.length > 0);
    assert.ok(logs.every(l => !l.includes('secret') && !l.includes('rtsp://')));
});
