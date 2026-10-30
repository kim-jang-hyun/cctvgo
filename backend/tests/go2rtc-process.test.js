'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Go2rtcProcess, maskSecrets } = require('../streams/go2rtc-process');

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

test('go2rtc 출력은 비밀번호를 가린 채 logs/go2rtc.log 에 남는다', async () => {
    const t = setup();
    await t.p.start('x');
    t.children[0].stdout.write('INF url=rtsp://admin:secret@192.168.0.5:554/x\n');
    t.children[0].stderr.write('ERR rtsp://u:p@h/y\n');
    await new Promise(r => setTimeout(r, 50));
    const log = fs.readFileSync(path.join(t.installDir, 'logs', 'go2rtc.log'), 'utf8');
    assert.ok(log.includes('rtsp://***@192.168.0.5:554/x'));
    assert.ok(!log.includes('secret'));
    assert.ok(!log.includes('u:p@'));
    t.p.stop();
});

test('go2rtc.log 가 5MB 를 넘으면 시작할 때 go2rtc.old.log 로 돌린다', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.installDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(t.installDir, 'logs', 'go2rtc.log'), Buffer.alloc(5 * 1024 * 1024 + 1));
    await t.p.start('x');
    assert.ok(fs.existsSync(path.join(t.installDir, 'logs', 'go2rtc.old.log')));
    const fresh = path.join(t.installDir, 'logs', 'go2rtc.log');
    assert.ok(!fs.existsSync(fresh) || fs.statSync(fresh).size < 1024);
    t.p.stop();
});
