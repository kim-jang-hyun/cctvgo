'use strict';
const crypto = require('crypto');
const dgram = require('dgram');
const { execFile } = require('child_process');
const { maskIp } = require('./diag');

/**
 * 서비스 시작 시 환경 점검 (진단 기록용, 실패해도 서비스에 영향 없음).
 * 방화벽 규칙, Windows 네트워크 프로필(공용/개인), STUN 바깥 주소와 그 종류, 기본 게이트웨이, 공유기 UPnP 응답 여부.
 * UPnP 는 응답 여부만 조회한다 (포트를 열지 않는다). 나중에 UPnP 기능을 넣을지 판단하는 근거다.
 */

function ipNum(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    if (!m) return null;
    return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
}

const inRange = (n, base, bits) => (n >>> (32 - bits)) === (ipNum(base) >>> (32 - bits));

function classifyIp(ip) {
    const n = ipNum(ip);
    if (n === null) return 'unknown';
    if (inRange(n, '100.64.0.0', 10)) return 'cgnat';
    if (inRange(n, '10.0.0.0', 8) || inRange(n, '172.16.0.0', 12) || inRange(n, '192.168.0.0', 16)) return 'private';
    return 'public';
}

/** cctvgo.bat(utils\ensure_firewall.ps1)과 같은 규칙 이름: 설치 폴더(소문자) SHA-1 앞 8자리 */
function firewallRuleName(installDir) {
    const dir = String(installDir).replace(/[\\/]+$/, '').toLowerCase();
    return 'CCTVGO go2rtc ' + crypto.createHash('sha1').update(dir, 'utf8').digest('hex').slice(0, 8);
}

function runCommand(cmd, args) {
    return new Promise(resolve => {
        execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => {
            resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || '') });
        });
    });
}

/** 공유기에 UPnP 장치 검색(SSDP M-SEARCH)을 보내 응답이 있는지만 본다 */
function ssdpQuery({ timeoutMs = 3000 } = {}) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = v => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.close(); } catch (e) { /* 이미 닫힘 */ }
            resolve(v);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        sock.on('error', () => finish(false));
        sock.on('message', msg => { if (/^HTTP\/1\.1 200/i.test(msg.toString('latin1'))) finish(true); });
        const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n'
            + 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
        sock.send(msg, 1900, '239.255.255.250', err => { if (err) finish(false); });
    });
}

const ps = script => ['-NoProfile', '-Command', script];

async function safe(fn, fallback) {
    try { return await fn(); } catch (e) { return fallback; }
}

async function checkEnvironment({ installDir, run = runCommand, stun, ssdp = ssdpQuery }) {
    const firewallRule = await safe(async () => {
        const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${firewallRuleName(installDir)}`]);
        return r.code === 0 && /CCTVGO go2rtc/.test(r.stdout) ? 'present' : 'missing';
    }, 'unknown');
    const networkProfile = await safe(async () => {
        const r = await run('powershell', ps('(Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory) -join ","'));
        return r.stdout.trim() || null;
    }, null);
    const gateway = await safe(async () => {
        const r = await run('powershell', ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"));
        return r.stdout.trim() || null;
    }, null);
    const mapped = await safe(() => stun(), null);
    const upnp = (await safe(() => ssdp(), false)) ? 'responded' : 'no-response';
    return {
        firewallRule,
        networkProfile,
        gateway,
        publicIp: mapped ? maskIp(mapped.ip) : null,
        publicIpClass: mapped ? classifyIp(mapped.ip) : 'unknown',
        upnp,
    };
}

module.exports = { classifyIp, firewallRuleName, checkEnvironment, ssdpQuery, runCommand };
