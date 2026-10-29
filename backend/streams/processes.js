'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 영상 프로세스(run_single_stream.bat 루프 cmd + cctvgo-ffmpeg.exe) 찾기/실행/종료.
 * 같은 PC에 다른 CCTVGO 설치(예: 개발 폴더와 package 폴더)가 함께 돌 수 있으므로
 * 명령줄에 "이 설치 폴더\run_single_stream.bat" 또는 "이 설치 폴더\ffmpeg\bin\cctvgo-ffmpeg.exe" 가 있는 것만 다룬다.
 */

function dirPrefix(scriptDir) {
    return String(scriptDir).replace(/[\\/]+$/, '').toLowerCase() + '\\';
}

function isOurStreamProcess(commandLine, scriptDir) {
    if (!commandLine) return false;
    const cl = commandLine.toLowerCase();
    const dir = dirPrefix(scriptDir);
    return cl.includes(dir + 'run_single_stream.bat') || cl.includes(dir + 'ffmpeg\\bin\\cctvgo-ffmpeg.exe');
}

/** streamK 영상의 프로세스인지 (stream1 이 stream10/stream11 에 걸리지 않게 경계를 확인한다) */
function matchesStream(commandLine, k, scriptDir) {
    if (!isOurStreamProcess(commandLine, scriptDir)) return false;
    const cl = commandLine.toLowerCase();
    return new RegExp(`(^|[^a-z0-9])stream${k}\\.m3u8`).test(cl) || new RegExp(`hls\\\\stream${k}(["\\\\\\s]|$)`).test(cl);
}

function listProcesses() {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe' or Name='cctvgo-ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    return new Promise((resolve, reject) => {
        // PowerShell 이 멈추면 카메라 변경 작업이 계속 기다리게 되므로 시간 제한을 둔다
        execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (error, stdout) => {
            if (error) return reject(error);
            const text = stdout.trim();
            if (!text) return resolve([]);
            let data;
            try { data = JSON.parse(text); } catch (e) { return reject(e); }
            // 결과가 하나면 배열이 아니라 객체로 온다
            const list = Array.isArray(data) ? data : [data];
            resolve(list.map(p => ({ pid: p.ProcessId, commandLine: p.CommandLine || '' })));
        });
    });
}

/** 프로세스와 자식까지 종료한다. 이미 끝난 프로세스면 조용히 넘어간다 */
function killTree(pid) {
    return new Promise(resolve => {
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    });
}

/** 카메라 영상 하나를 켠다 (예전 start_ffmpeg.bat 과 같은 방식). 주소는 & 등이 깨지지 않도록 환경 변수 STREAM_URL 로 넘긴다 */
function spawnStream({ scriptDir, k, url }) {
    fs.mkdirSync(path.join(scriptDir, 'hls', `stream${k}`), { recursive: true });
    fs.mkdirSync(path.join(scriptDir, 'logs'), { recursive: true });
    const logFd = fs.openSync(path.join(scriptDir, 'logs', `stream_${k}.log`), 'a');
    const script = path.join(scriptDir, 'run_single_stream.bat');
    try {
        // /s 는 바깥 따옴표 한 쌍만 벗기므로 설치 경로에 공백이 있어도 된다
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${script}" "hls\\stream${k}" "stream${k}.m3u8" 5"`], {
            cwd: scriptDir,
            env: { ...process.env, STREAM_URL: url },
            stdio: ['ignore', logFd, logFd],
            windowsHide: true,
            windowsVerbatimArguments: true,
        });
        child.on('error', error => console.error(`[STREAM] stream${k} 실행 실패: ${error.message}`));
    } finally {
        fs.closeSync(logFd);
    }
}

module.exports = { isOurStreamProcess, matchesStream, listProcesses, killTree, spawnStream };
