'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_DELAY_MS = 30000;
// 이만큼 살아 있었으면 정상 동작으로 보고 다시 띄우는 간격을 처음(1초)으로 돌린다
const HEALTHY_MS = 60000;

/**
 * go2rtc.exe 를 자식 프로세스로 실행하고 비정상 종료 시 다시 띄운다.
 * 같은 PC 의 다른 설치 폴더(예: 개발 폴더와 package 폴더) CCTVGO 를 건드리지 않도록
 * 시작 시 정리는 명령줄에 "이 설치 폴더\go2rtc\go2rtc.exe" 가 있는 프로세스만 한다.
 */
class Go2rtcProcess {
    constructor({
        installDir, logDir, spawnImpl = spawn, procs = require('./processes'),
        delay = ms => new Promise(r => setTimeout(r, ms)), onRestart = () => {}, event = () => {},
        log = console.log, error = console.error,
    }) {
        this.dir = path.join(installDir, 'go2rtc');
        this.logDir = logDir;
        this.spawnImpl = spawnImpl;
        this.procs = procs;
        this.delay = delay;
        this.onRestart = onRestart;
        this.event = event;
        this.log = log;
        this.error = error;
        this.child = null;
        this.stopped = false;
        this.nextDelay = 1000;
    }

    get exe() { return path.join(this.dir, 'go2rtc.exe'); }
    get configPath() { return path.join(this.dir, 'go2rtc.yaml'); }

    async start(configText) {
        this.stopped = false;
        try {
            const prefix = this.exe.toLowerCase();
            const list = await this.procs.listProcesses();
            for (const p of list) {
                if ((p.commandLine || '').toLowerCase().includes(prefix)) await this.procs.killTree(p.pid);
            }
        } catch (e) {
            this.error(`[GO2RTC] 이전 go2rtc 정리 실패: ${e.message}`);
        }
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.configPath, configText, 'utf8');
        this._spawn();
    }

    _spawn() {
        let logFd = 'ignore';
        try {
            fs.mkdirSync(this.logDir, { recursive: true });
            logFd = fs.openSync(path.join(this.logDir, 'go2rtc.log'), 'a');
        } catch (e) {
            this.error(`[GO2RTC] 로그 파일 열기 실패: ${e.message}`);
        }
        const startedAt = Date.now();
        let child;
        try {
            child = this.spawnImpl(this.exe, ['-c', this.configPath], { windowsHide: true, stdio: ['ignore', logFd, logFd] });
        } finally {
            if (typeof logFd === 'number') fs.closeSync(logFd);
        }
        this.child = child;
        this.log('[GO2RTC] 시작');
        child.on('error', e => this.error(`[GO2RTC] 실행 실패: ${e.message}`));
        child.on('exit', code => {
            if (this.child !== child) return;
            this.child = null;
            if (this.stopped) return;
            if (Date.now() - startedAt >= HEALTHY_MS) this.nextDelay = 1000;
            const wait = this.nextDelay;
            this.nextDelay = Math.min(this.nextDelay * 2, MAX_DELAY_MS);
            this.error(`[GO2RTC] 종료됨 (코드 ${code}), ${wait / 1000}초 뒤 다시 시작`);
            this.event('go2rtc-exit', { code, restartInMs: wait });
            this.delay(wait).then(() => {
                if (this.stopped) return;
                this._spawn();
                this.onRestart();
            });
        });
    }

    stop() {
        this.stopped = true;
        if (this.child) {
            const c = this.child;
            this.child = null;
            c.kill();
        }
    }
}

module.exports = { Go2rtcProcess };
