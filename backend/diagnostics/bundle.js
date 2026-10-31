'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { parseCameras, parseRtspUrl } = require('../finder/cctv-file');
const { maskSecrets } = require('../streams/go2rtc-process');

/**
 * 진단 파일(zip). 고객이 문의할 때 이 파일 하나만 보내면 원인을 볼 수 있게 한다.
 * 넣는 것: 진단 요약, PC 정보, 카메라 목록(계정 제외), go2rtc 현재 상태, logs 폴더(최근 파일부터).
 * 넣지 않는 것: config.json(로그인 비밀번호), go2rtc.yaml·cctv.txt 원본(카메라 비밀번호).
 * 모든 글자는 한 번 더 걸러 "아이디:비밀번호@" 가 남지 않게 한다.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// --- zip (외부 모듈 없이: pkg 로 묶는 Node 18 에는 zlib.crc32 가 없다) ---
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/** entries: [{ name, data }] → zip Buffer. 이름은 UTF-8(플래그 비트 11), 내용은 deflate */
function createZip(entries, now = new Date()) {
    const { time, date } = dosTime(now);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
        const comp = zlib.deflateRawSync(raw);
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, comp);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comp.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

/** 크면 마지막 maxBytes 만 남긴다. 줄 중간에서 시작하지 않도록 다음 줄부터 */
function tailText(buf, maxBytes) {
    if (buf.length <= maxBytes) return buf;
    let start = buf.length - maxBytes;
    const nl = buf.indexOf(0x0A, start);
    if (nl >= 0 && nl < buf.length - 1) start = nl + 1;
    return Buffer.concat([Buffer.from(`[앞부분 생략: ${start}바이트]\n`, 'utf8'), buf.subarray(start)]);
}

/** cctv.txt → 번호, 이름, 호스트:포트/경로, 서브 (아이디/비밀번호 없이) */
function camerasSummary(text) {
    const where = url => {
        const p = parseRtspUrl(url);
        return p ? `${p.host}:${p.port}${p.path}` : '(주소를 읽을 수 없음)';
    };
    const cams = parseCameras(text || '');
    if (cams.length === 0) return '등록된 카메라 없음\n';
    return cams.map((c, i) => `${i + 1}. ${c.name || '(이름 없음)'} | ${where(c.url)} | 서브: ${c.subUrl ? where(c.subUrl) : '없음'}`).join('\n') + '\n';
}

const SYSTEM_SCRIPT = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$o = Get-CimInstance Win32_OperatingSystem',
    '"OS: $($o.Caption) $($o.Version) $($o.OSArchitecture)"',
    '"Boot: $($o.LastBootUpTime)  Now: $(Get-Date -Format o)  TimeZone: $((Get-TimeZone).Id)"',
    '"RAM total(GB): $([math]::Round($o.TotalVisibleMemorySize/1MB,1))  free(GB): $([math]::Round($o.FreePhysicalMemory/1MB,1))"',
    '"CPU: " + ((Get-CimInstance Win32_Processor | ForEach-Object { $_.Name + \' (\' + $_.NumberOfLogicalProcessors + \' threads)\' }) -join \', \')',
    '"GPU: " + ((Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + \' driver \' + $_.DriverVersion }) -join \', \')',
    '$disk = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq \'C:\' }',
    '"Disk C free(GB): $([math]::Round($disk.FreeSpace/1GB,1))"',
    '"Network profiles: " + ((Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + \'=\' + $_.NetworkCategory }) -join \', \')',
    'Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | ForEach-Object { "Adapter: $($_.InterfaceAlias) | IPv4: $($_.IPv4Address.IPAddress -join \',\') | Gateway: $($_.IPv4DefaultGateway.NextHop -join \',\') | DNS: $($_.DNSServer.ServerAddresses -join \',\')" }',
    '"Processes:"',
    'Get-Process cctvgo-service,go2rtc,cctvgo-ffmpeg,cloudflared -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.ProcessName) pid=$($_.Id) MB=$([math]::Round($_.WorkingSet64/1MB)) CPUsec=$([math]::Round($_.CPU)) start=$($_.StartTime)" }',
    '"Firewall rules (CCTVGO):"',
    'Get-NetFirewallRule -DisplayName \'CCTVGO*\' -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.DisplayName) enabled=$($_.Enabled) profile=$($_.Profile) action=$($_.Action)" }',
].join('\n');

function systemInfo() {
    return new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', SYSTEM_SCRIPT], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !stdout) return reject(error);
            resolve(String(stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''));
        });
    });
}

const maskText = s => String(s).split('\n').map(maskSecrets).join('\n');

/**
 * zip 에 넣을 항목들. 로그는 최근 파일부터 넣고, 파일마다 maxFileBytes, 합쳐서 maxTotalBytes(압축 전)까지.
 * 넘쳐서 빠진 파일은 "빠진-파일.txt" 에 이름을 남긴다.
 */
async function buildBundle({
    logDir, cctvPath, diagText, systemInfo: getSystem = systemInfo, go2rtcStreams, info = {},
    maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES,
}) {
    const entries = [];
    const add = (name, text) => entries.push({ name, data: Buffer.from(maskText(text), 'utf8') });
    const safe = async (fn, label) => { try { return await fn(); } catch (e) { return `${label} 를 얻지 못했습니다: ${e.message}`; } };

    add('요약.txt', [
        `CCTVGO 진단 파일 (만든 시각: ${new Date().toISOString()})`,
        ...Object.entries(info).map(([k, v]) => `${k}: ${v}`),
        '',
        await safe(async () => diagText(), '진단 요약'),
    ].join('\n'));
    add('PC정보.txt', await safe(getSystem, 'PC 정보'));
    add('카메라.txt', await safe(async () => camerasSummary(fs.existsSync(cctvPath) ? fs.readFileSync(cctvPath, 'utf8') : ''), '카메라 목록'));
    add('go2rtc-상태.json', await safe(async () => JSON.stringify(await go2rtcStreams(), null, 1), 'go2rtc 상태'));

    let total = entries.reduce((a, e) => a + e.data.length, 0);
    const skipped = [];
    let files = [];
    try {
        files = fs.readdirSync(logDir)
            .map(n => ({ n, st: fs.statSync(path.join(logDir, n)) }))
            .filter(f => f.st.isFile())
            .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    } catch (e) { /* logs 폴더가 없으면 로그 없이 */ }
    for (const f of files) {
        let data;
        try { data = tailText(fs.readFileSync(path.join(logDir, f.n)), maxFileBytes); } catch (e) { skipped.push(`logs/${f.n} (읽기 실패: ${e.message})`); continue; }
        if (total + data.length > maxTotalBytes) { skipped.push(`logs/${f.n} (전체 크기 한도)`); continue; }
        const masked = Buffer.from(maskText(data.toString('utf8')), 'utf8');
        entries.push({ name: `logs/${f.n}`, data: masked });
        total += masked.length;
    }
    if (skipped.length) add('빠진-파일.txt', skipped.join('\n') + '\n');
    return entries;
}

module.exports = { createZip, tailText, camerasSummary, buildBundle, crc32, systemInfo };
