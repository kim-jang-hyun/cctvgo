'use strict';
const { execFile } = require('child_process');

/**
 * Windows 프로세스 찾기/종료 (go2rtc 정리용).
 * 같은 PC 에 다른 CCTVGO 설치(예: 개발 폴더와 package 폴더)가 함께 돌 수 있으므로
 * 대상 고르기(명령줄의 설치 폴더 비교)는 호출하는 쪽에서 한다.
 */
function listProcesses() {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='go2rtc.exe' or Name='cctvgo-ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
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

module.exports = { listProcesses, killTree };
