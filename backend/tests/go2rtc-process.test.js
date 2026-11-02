'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Go2rtcProcess, maskSecrets } = require('../streams/go2rtc-process');
const { datedLogName } = require('../diagnostics/log-files');

/** spawn 대신 쓰는 가짜 자식 프로세스. exit(code) 로 종료를 흉내 낸다 */
function fakeSpawn() {
    const children = [];
    const spawnImpl = (exe, args) => {
        const child = new EventEmitter();
        child.exe = exe;
        child.args = args;
        child.killed = false;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { child.killed = true; child.emit('exit', null); };
        children.push(child);
        return child;
    };
    return { spawnImpl, children };
}

function setup(running = [], { makeConfig } = {}) {
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-g2-'));
    const logDir = path.join(installDir, 'logs');
    const killed = [];
    const procs = {
        listProcesses: async () => running,
        killTree: async pid => { killed.push(pid); },
    };
    const sp = fakeSpawn();
    const delays = [];
    const restarts = [];
    const events = [];
    const p = new Go2rtcProcess({
        installDir, logDir, spawnImpl: sp.spawnImpl, procs,
        delay: ms => { delays.push(ms); return Promise.resolve(); },
        onRestart: () => restarts.push(1),
        event: (kind, detail) => events.push({ kind, detail }),
        log: () => {}, error: () => {}, makeConfig,
    });
    return { p, installDir, killed, delays, restarts, events, ...sp };
}

const tick = () => new Promise(r => setImmediate(r));

test('시작: 설정 파일을 쓰고 이 폴더의 go2rtc.exe 를 -c 설정으로 실행한다', async () => {
    const t = setup();
    await t.p.start('api: {}\n');
    const exe = path.join(t.installDir, 'go2rtc', 'go2rtc.exe');
    const cfg = path.join(t.installDir, 'go2rtc', 'go2rtc.yaml');
    assert.equal(fs.readFileSync(cfg, 'utf8'), 'api: {}\n');
    assert.equal(t.children.length, 1);
    assert.equal(t.children[0].exe, exe);
    assert.deepEqual(t.children[0].args, ['-c', cfg]);
    t.p.stop();
});

test('시작: 이 폴더에서 남은 go2rtc 만 정리하고 다른 설치 폴더의 것은 남긴다', async () => {
    const installDirHolder = {};
    const running = () => [
        { pid: 1, commandLine: `"${installDirHolder.dir}\\go2rtc\\go2rtc.exe" -c x` },
        { pid: 2, commandLine: '"C:\\cctvgo\\package-other\\go2rtc\\go2rtc.exe" -c y' },
        { pid: 3, commandLine: 'notepad.exe' },
    ];
    const t = setup();
    installDirHolder.dir = t.installDir;
    t.p.procs.listProcesses = async () => running();
    await t.p.start('x');
    assert.deepEqual(t.killed, [1]);
    t.p.stop();
});

test('비정상 종료: 1초, 2초 ... 최대 30초로 늦추며 다시 띄우고 onRestart 를 부른다', async () => {
    const t = setup();
    await t.p.start('x');
    for (let i = 0; i < 7; i++) {
        t.children[t.children.length - 1].emit('exit', 1);
        await tick(); await tick();
    }
    assert.deepEqual(t.delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.equal(t.children.length, 8);
    assert.equal(t.restarts.length, 7);
    assert.ok(t.events.some(e => e.kind === 'go2rtc-exit'));
    t.p.stop();
});

test('stop 뒤에는 다시 띄우지 않는다', async () => {
    const t = setup();
    await t.p.start('x');
    t.p.stop();
    await tick(); await tick();
    assert.equal(t.children[0].killed, true);
    assert.equal(t.children.length, 1);
    assert.equal(t.restarts.length, 0);
});

test('다시 띄울 때 지금의 스트림 표로 설정 파일을 새로 쓴다 (시작 뒤 추가·수정한 카메라도 살아남게)', async () => {
    let current = 'v1';
    const t = setup([], { makeConfig: () => current });
    await t.p.start('v0');
    current = 'v2';
    t.children[0].emit('exit', 1);
    await tick(); await tick();
    assert.equal(fs.readFileSync(path.join(t.installDir, 'go2rtc', 'go2rtc.yaml'), 'utf8'), 'v2');
    assert.equal(t.children.length, 2);
    t.p.stop();
});

test('maskSecrets: 로그의 주소에서 아이디/비밀번호를 가린다', () => {
    assert.equal(
        maskSecrets('WRN error="i/o timeout" url=rtsp://admin:dash1101%21@192.168.0.3:554/onvif1 x'),
        'WRN error="i/o timeout" url=rtsp://***@192.168.0.3:554/onvif1 x');
    assert.equal(maskSecrets('ffmpeg:rtsp://a:b@1.2.3.4/x#video=h264'), 'ffmpeg:rtsp://***@1.2.3.4/x#video=h264');
    assert.equal(maskSecrets('plain line'), 'plain line');
});

test('go2rtc 출력은 비밀번호를 가린 채 날짜별 logs/go2rtc-YYYY-MM-DD.log 에 남는다', async () => {
    const t = setup();
    await t.p.start('x');
    t.children[0].stdout.write('INF url=rtsp://admin:secret@192.168.0.5:554/x\n');
    t.children[0].stderr.write('ERR rtsp://u:p@h/y\n');
    await new Promise(r => setTimeout(r, 50));
    const log = fs.readFileSync(path.join(t.installDir, 'logs', datedLogName('go2rtc')), 'utf8');
    assert.ok(log.includes('rtsp://***@192.168.0.5:554/x'));
    assert.ok(!log.includes('secret'));
    assert.ok(!log.includes('u:p@'));
    t.p.stop();
});

test('설치 경로에 공백이 있어도 변환 프로그램을 찾게: pathDirs 를 go2rtc 의 PATH 앞에 넣는다 (go2rtc 는 ffmpeg.bin 을 공백에서 자른다)', async () => {
    const t = setup();
    const seen = [];
    const orig = t.spawnImpl;
    t.p.spawnImpl = (exe, args, opts) => { seen.push(opts); return orig(exe, args, opts); };
    t.p.pathDirs = ['C:\Program Files\CCTVGO\ffmpeg\bin'];
    await t.p.start('x');
    const env = seen[0].env;
    const keys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
    assert.equal(keys.length, 1, 'PATH 키는 하나만 (Windows 는 대소문자 구분 없음)');
    assert.ok(env[keys[0]].startsWith('C:\Program Files\CCTVGO\ffmpeg\bin;'));
    t.p.stop();
});

test('실행 자체가 실패(error)해도 다시 시도하고, 원인 추정과 함께 기록한다', async () => {
    const t = setup();
    await t.p.start('x');
    const err = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    t.children[0].emit('error', err);
    t.children[0].emit('exit', null);   // error 뒤에 exit 가 와도 한 번만 처리
    await tick(); await tick();
    assert.equal(t.children.length, 2);
    assert.deepEqual(t.delays, [1000]);
    const ev = t.events.find(e => e.kind === 'go2rtc-start-failed');
    assert.ok(ev);
    assert.equal(ev.detail.code, 'EPERM');
    assert.match(ev.detail.hint, /백신/);
    t.p.stop();
});

test('go2rtc.exe 가 없으면 "파일 없음(백신 격리 의심)" 으로 기록한다', async () => {
    const t = setup();
    await t.p.start('x');
    t.children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await tick(); await tick();
    const ev = t.events.find(e => e.kind === 'go2rtc-start-failed');
    assert.equal(ev.detail.exeExists, false);
    assert.match(ev.detail.hint, /go2rtc\.exe 가 없/);
    t.p.stop();
});

test('spawn 이 바로 예외를 던져도 서비스가 죽지 않고 다시 시도한다', async () => {
    const t = setup();
    let first = true;
    const orig = t.spawnImpl;
    t.p.spawnImpl = (...a) => { if (first) { first = false; throw Object.assign(new Error('bad'), { code: 'EACCES' }); } return orig(...a); };
    await t.p.start('x');
    await tick(); await tick();
    assert.equal(t.children.length, 1);
    assert.ok(t.events.some(e => e.kind === 'go2rtc-start-failed' && e.detail.code === 'EACCES'));
    t.p.stop();
});

test('계속 실패해도 기록은 처음 5번과 그 뒤 20번마다만 (운용 기록이 이것으로 덮이지 않게)', async () => {
    const t = setup();
    await t.p.start('x');
    for (let i = 0; i < 40; i++) {
        t.children[t.children.length - 1].emit('exit', 1);
        await tick(); await tick();
    }
    const counts = t.events.filter(e => e.kind === 'go2rtc-exit').map(e => e.detail.failures);
    assert.deepEqual(counts, [1, 2, 3, 4, 5, 20, 40]);
    t.p.stop();
});

test('60초 넘게 잘 돌다 죽으면 실패 횟수를 처음부터 센다', async () => {
    let clock = 0;
    const t = setup();
    t.p.now = () => clock;
    await t.p.start('x');
    t.children[0].emit('exit', 1);
    await tick(); await tick();
    clock = 120000;
    t.children[1].emit('exit', 1);
    await tick(); await tick();
    assert.deepEqual(t.events.filter(e => e.kind === 'go2rtc-exit').map(e => e.detail.failures), [1, 1]);
    assert.deepEqual(t.delays, [1000, 1000]);
    t.p.stop();
});

test('다시 띄우기 전에 죽은 go2rtc 가 남긴 변환 FFmpeg(내부 RTSP 포트를 쓰는 것)만 정리한다', async () => {
    const t = setup();
    t.p.rtspPort = 8554;
    await t.p.start('x');
    t.killed.length = 0;
    t.p.procs.listProcesses = async () => [
        { pid: 11, commandLine: 'cctvgo-ffmpeg.exe -user_agent go2rtc/ffmpeg -i rtsp://127.0.0.1:8554/cctvgo_k1?video -f rtsp rtsp://127.0.0.1:8554/abc' },
        { pid: 12, commandLine: 'cctvgo-ffmpeg.exe -user_agent go2rtc/ffmpeg -i rtsp://127.0.0.1:18554/x' },
        { pid: 13, commandLine: '"C:\other\ffmpeg\bin\cctvgo-ffmpeg.exe" -i rtsp://192.168.0.5/x' },
    ];
    t.children[0].emit('exit', 1);
    await tick(); await tick(); await tick(); await tick();
    assert.deepEqual(t.killed, [11]);
    assert.equal(t.children.length, 2);
    t.p.stop();
});

test('stop: go2rtc 와 자식(변환 FFmpeg)까지 함께 끈다', async () => {
    const t = setup();
    const synced = [];
    t.p.killTreeSync = pid => synced.push(pid);
    await t.p.start('x');
    t.children[0].pid = 4321;
    t.p.stop();
    assert.deepEqual(synced, [4321]);
    assert.equal(t.children[0].killed, true);
});
