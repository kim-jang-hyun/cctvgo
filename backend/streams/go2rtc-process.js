'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const { appendLog } = require('../diagnostics/log-files');

const MAX_DELAY_MS = 30000;
// 이만큼 살아 있었으면 정상 동작으로 보고 다시 띄우는 간격을 처음(1초)으로 돌린다
const HEALTHY_MS = 60000;
// 계속 실패할 때 운용 기록이 이것으로 덮이지 않게: 처음 몇 번과 그 뒤 일정 횟수마다만 남긴다
const RECORD_FIRST = 5;
const RECORD_EVERY = 20;

/** go2rtc 는 연결 오류 때 카메라 주소(아이디/비밀번호 포함)를 그대로 찍는다. 로그에 남기기 전에 가린다 */
function maskSecrets(line) {
    return String(line).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']*@/gi, '$1***@');
}

/**
 * go2rtc.exe 를 자식 프로세스로 실행하고 비정상 종료 시 다시 띄운다.
 * 같은 PC 의 다른 설치 폴더(예: 개발 폴더와 package 폴더) CCTVGO 를 건드리지 않도록
 * 시작 시 정리는 명령줄에 "이 설치 폴더\go2rtc\go2rtc.exe" 가 있는 프로세스만 한다.
 */
class Go2rtcProcess {
    constructor({
        installDir, logDir, spawnImpl = spawn, procs = require('./processes'), makeConfig = null, pathDirs = [],
        delay = ms => new Promise(r => setTimeout(r, ms)), onRestart = () => {}, event = () => {},
        log = console.log, error = console.error, now = Date.now, rtspPort = null,
        killTreeSync = pid => execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }),
    }) {
        this.dir = path.join(installDir, 'go2rtc');
        this.logDir = logDir;
        this.spawnImpl = spawnImpl;
        this.procs = procs;
        this.makeConfig = makeConfig;   // 다시 띄울 때 지금의 스트림 표로 설정을 새로 쓰기 위한 함수
        // go2rtc 의 PATH 앞에 넣을 폴더 (변환 프로그램). go2rtc 는 ffmpeg.bin 을 공백에서 잘라 실행하므로
        // "C:\Program Files\..." 같은 설치 경로에서는 전체 경로 대신 PATH 로 찾게 한다 (따옴표는 경로의 일부로 남아 안 됨, 실기 확인)
        this.pathDirs = pathDirs;
        this.now = now;
        this.rtspPort = rtspPort;
        this.killTreeSync = killTreeSync;
        this.failures = 0;
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

    /** 자식의 출력을 줄 단위로 받아 비밀번호를 가린 뒤 로그 파일에 쓴다 */
    _pipeLog(stream) {
        if (!stream) return;
        // 날짜별 파일 (몇 달씩 켜 두어도 한 파일이 커지지 않고, 30일 지나면 지워진다)
        readline.createInterface({ input: stream }).on('line', line => appendLog(this.logDir, 'go2rtc', maskSecrets(line)));
    }

    /** 자식에게 줄 환경 변수. Windows 는 PATH 이름의 대소문자를 가리지 않으므로 이미 있는 키(Path 등)를 그대로 고친다 */
    _env() {
        const env = { ...process.env };
        if (!this.pathDirs.length) return env;
        const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
        env[key] = [...this.pathDirs, env[key] || ''].join(';');
        return env;
    }

    /** 실행 실패 원인 추정 (고객 PC 에서 흔한 것: 백신이 exe 를 지우거나 막음) */
    _hint(code) {
        if (code === 'ENOENT' || !fs.existsSync(this.exe)) return 'go2rtc.exe 가 없습니다 (백신 격리 또는 설치 파일 누락 의심)';
        if (code === 'EPERM' || code === 'EACCES') return '실행이 거부되었습니다 (백신 차단 의심)';
        return '실행하지 못했습니다';
    }

    _spawn() {
        const startedAt = this.now();
        let child;
        try {
            child = this.spawnImpl(this.exe, ['-c', this.configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: this._env() });
        } catch (e) {
            this._ended(startedAt, { error: e });
            return;
        }
        this._pipeLog(child.stdout);
        this._pipeLog(child.stderr);
        this.child = child;
        this.log('[GO2RTC] 시작');
        // 실행 실패는 'error' 만 오고 'exit' 가 안 올 수 있다. 둘 다 와도 한 번만 처리한다
        let ended = false;
        const end = result => {
            if (ended || this.child !== child) return;
            ended = true;
            this.child = null;
            this._ended(startedAt, result);
        };
        child.on('error', e => end({ error: e }));
        child.on('exit', code => end({ code }));
    }

    /** 종료·실행 실패 공통: 기록하고 1초, 2초 ... 최대 30초로 늦추며 다시 띄운다 */
    _ended(startedAt, { code = null, error = null }) {
        if (this.stopped) return;
        if (this.now() - startedAt >= HEALTHY_MS) {
            this.nextDelay = 1000;
            this.failures = 0;
        }
        this.failures++;
        const wait = this.nextDelay;
        this.nextDelay = Math.min(this.nextDelay * 2, MAX_DELAY_MS);
        const record = this.failures <= RECORD_FIRST || this.failures % RECORD_EVERY === 0;
        if (error) {
            const hint = this._hint(error.code);
            this.error(`[GO2RTC] 실행 실패: ${error.message} - ${hint}, ${wait / 1000}초 뒤 다시 시도`);
            if (record) this.event('go2rtc-start-failed', { code: error.code || null, exeExists: fs.existsSync(this.exe), hint, failures: this.failures, restartInMs: wait });
        } else {
            this.error(`[GO2RTC] 종료됨 (코드 ${code}), ${wait / 1000}초 뒤 다시 시작`);
            if (record) this.event('go2rtc-exit', { code, failures: this.failures, restartInMs: wait });
        }
        this.delay(wait).then(async () => {
            if (this.stopped) return;
            await this._killOrphanFfmpeg();
            if (this.stopped) return;
            if (this.makeConfig) {
                try { fs.writeFileSync(this.configPath, this.makeConfig(), 'utf8'); } catch (e) { this.error(`[GO2RTC] 설정 쓰기 실패: ${e.message}`); }
            }
            this._spawn();
            if (this.child) this.onRestart();
        });
    }

    /**
     * go2rtc 가 강제로 끝나면 그 go2rtc 가 띄운 변환 FFmpeg 는 남는다 (Windows 는 자식을 같이 끄지 않음).
     * 남은 것은 같은 포트로 다시 뜬 go2rtc 에 붙어 카메라 연결과 그래픽 장치를 계속 쓴다 (시험에서 확인).
     * 내부 RTSP 포트(127.0.0.1)를 쓰는 go2rtc 용 FFmpeg 만 고른다 (다른 설치는 같은 포트를 쓸 수 없다)
     */
    async _killOrphanFfmpeg() {
        if (!this.rtspPort) return;
        const mark = `rtsp://127.0.0.1:${this.rtspPort}/`;
        try {
            const list = await this.procs.listProcesses();
            for (const p of list) {
                const cmd = p.commandLine || '';
                if (cmd.includes('go2rtc/ffmpeg') && cmd.includes(mark)) await this.procs.killTree(p.pid);
            }
        } catch (e) {
            this.error(`[GO2RTC] 남은 변환 정리 실패: ${e.message}`);
        }
    }

    /** 서비스가 끝날 때 부른다 (process 'exit' 안이라 동기로): go2rtc 와 자식 변환 FFmpeg 까지 끈다 */
    stop() {
        this.stopped = true;
        if (this.child) {
            const c = this.child;
            this.child = null;
            if (c.pid) {
                try { this.killTreeSync(c.pid); } catch (e) { /* 이미 끝남 */ }
            }
            c.kill();
        }
    }
}

module.exports = { Go2rtcProcess, maskSecrets };
