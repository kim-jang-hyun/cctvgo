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
        async listProcesses() { return running.map(p => ({ ...p })); },
        async killTree(pid) {
            calls.killed.push(pid);
            for (let i = running.length - 1; i >= 0; i--) if (running[i].pid === pid) running.splice(i, 1);
        },
        spawnStream({ k, url }) {
            calls.spawned.push({ k, url });
            running.push({ pid: nextPid++, commandLine: `cmd /c "${scriptDir}\\run_single_stream.bat "hls\\stream${k}" "stream${k}.m3u8" "5""` });
            running.push({ pid: nextPid++, commandLine: `${scriptDir}\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -i ${url} -f hls hls\\stream${k}\\stream${k}.m3u8` });
        },
    };
    return { procs, calls, running };
}

function setup(extraRunning = []) {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-sm-'));
    const f = fakeProcs(scriptDir);
    f.running.push(...extraRunning(scriptDir));
    const logs = [];
    const mgr = new StreamManager({ scriptDir, procs: f.procs, log: (...a) => logs.push(a.join(' ')) });
    return { mgr, scriptDir, logs, ...f };
}

const URLS = ['rtsp://a:secret@192.168.0.1:554/x', 'rtsp://a:secret@192.168.0.2:554/y', 'rtsp://a:secret@192.168.0.3:554/z'];

test('startAll: 우리 프로세스만 정리하고 hls 를 비운 뒤 1..N 으로 켠다', async () => {
    const { mgr, scriptDir, calls } = setup(dir => [
        { pid: 1, commandLine: `${dir}\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -i x -f hls hls\\stream1\\stream1.m3u8` },
        { pid: 2, commandLine: 'C:\\other\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -f hls hls\\stream1\\stream1.m3u8' },
        { pid: 3, commandLine: 'cmd /c notepad.exe' },
    ]);
    fs.mkdirSync(path.join(scriptDir, 'hls', 'stream9'), { recursive: true });
    await mgr.startAll(URLS);
    assert.deepEqual(calls.killed, [1]);
    assert.equal(fs.existsSync(path.join(scriptDir, 'hls', 'stream9')), false);
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2, 3]);
    assert.equal(mgr.streamUrl(2), '/hls/stream3/stream3.m3u8');
    assert.equal(mgr.streamUrl(3), null);
});

test('remove 후 add: 번호를 재사용하지 않고 다른 카메라 번호는 그대로', async () => {
    const { mgr, calls } = setup(() => []);
    await mgr.startAll(URLS);
    await mgr.remove(0);
    assert.equal(mgr.streamUrl(0), '/hls/stream2/stream2.m3u8');
    assert.equal(mgr.streamUrl(1), '/hls/stream3/stream3.m3u8');
    const k = await mgr.add('rtsp://a:b@192.168.0.4:554/w');
    assert.equal(k, 4);
    assert.equal(mgr.streamUrl(2), '/hls/stream4/stream4.m3u8');
    assert.deepEqual(calls.spawned.map(s => s.k), [1, 2, 3, 4]);
});

test('remove: 그 카메라 프로세스만 종료한다', async () => {
    const { mgr, calls, running } = setup(() => []);
    await mgr.startAll(URLS);
    const before = running.map(p => p.pid);
    await mgr.remove(1);
    assert.deepEqual(calls.killed.sort(), before.filter((_, i) => i === 2 || i === 3).sort());
});

test('restart: 같은 번호로 끄고 켜며 다른 번호 프로세스는 건드리지 않는다', async () => {
    const { mgr, calls, running } = setup(() => []);
    await mgr.startAll(URLS);
    const stream2Pids = running.filter(p => /stream2\.m3u8/.test(p.commandLine)).map(p => p.pid);
    await mgr.restart(1, 'rtsp://n:p@192.168.0.2:554/y2');
    assert.deepEqual(calls.killed.sort(), stream2Pids.sort());
    assert.deepEqual(calls.spawned.at(-1), { k: 2, url: 'rtsp://n:p@192.168.0.2:554/y2' });
    assert.equal(mgr.streamUrl(1), '/hls/stream2/stream2.m3u8');
});

test('stop 순서: run_single_stream cmd 를 ffmpeg 보다 먼저 종료한다', async () => {
    const { mgr, calls, running } = setup(() => []);
    await mgr.startAll(URLS);
    // 목록에서 ffmpeg 가 먼저 나와도 루프 cmd 를 먼저 끈다 (안 그러면 루프가 ffmpeg 를 다시 띄운다)
    running.reverse();
    const loop = running.find(p => /run_single_stream/.test(p.commandLine) && /stream1\.m3u8/.test(p.commandLine)).pid;
    await mgr.remove(0);
    assert.equal(calls.killed[0], loop);
});

test('잘못된 순번이면 아무 프로세스도 건드리지 않고 오류를 낸다', async () => {
    const { mgr, calls } = setup(() => []);
    await mgr.startAll(URLS);
    await assert.rejects(() => mgr.remove(5));
    await assert.rejects(() => mgr.restart(-1, 'rtsp://x'));
    assert.deepEqual(calls.killed, []);
});

test('로그에 url 이 남지 않는다', async () => {
    const { mgr, logs } = setup(() => []);
    await mgr.startAll(URLS);
    await mgr.add('rtsp://a:secret@192.168.0.9:554/q');
    await mgr.restart(0, 'rtsp://a:secret@192.168.0.1:554/x');
    await mgr.remove(0);
    assert.ok(logs.length > 0);
    assert.ok(logs.every(l => !l.includes('secret') && !l.includes('rtsp://')));
});
