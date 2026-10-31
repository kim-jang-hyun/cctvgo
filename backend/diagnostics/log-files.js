'use strict';
const fs = require('fs');
const path = require('path');

/**
 * logs 폴더 관리.
 * - 계속 이어 쓰는 로그는 날짜별 파일(이름-YYYY-MM-DD.log)로 나눈다. 파일 하나에 이어 쓰면 수정 날짜가 늘 최신이라
 *   "오래된 로그 지우기"에 걸리지 않고 몇 년씩 커지기 때문이다. 서비스를 재시작하지 않아도 날짜가 바뀌면 새 파일에 쓴다.
 * - 30일 지난 .log 는 지운다. 그래도 폴더가 500MB 를 넘으면 가장 오래된 .log 부터 지운다.
 *   연결 통계(connection-stats.json) 같은 .log 가 아닌 파일은 남긴다 (UPnP 등 기능 추가의 근거).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function datedLogName(base, date = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${base}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.log`;
}

/** 한 줄 추가. 로그 쓰기 실패가 서비스에 영향을 주면 안 되므로 예외를 던지지 않는다 */
function appendLog(logDir, base, line, now = Date.now) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, datedLogName(base, new Date(now()))), line + '\n', 'utf8');
    } catch (e) { /* 무시 */ }
}

function pruneLogs(logDir, { now = Date.now(), keepDays = KEEP_DAYS, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
    const deleted = [];
    let files;
    try {
        files = fs.readdirSync(logDir)
            .filter(n => n.toLowerCase().endsWith('.log'))
            .map(n => {
                const st = fs.statSync(path.join(logDir, n));
                return { name: n, mtime: st.mtimeMs, size: st.size };
            })
            .sort((a, b) => a.mtime - b.mtime);
    } catch (e) {
        return { deleted };
    }
    const remove = f => {
        try { fs.unlinkSync(path.join(logDir, f.name)); deleted.push(f.name); return true; } catch (e) { return false; }
    };
    const kept = [];
    for (const f of files) {
        if (now - f.mtime > keepDays * DAY_MS && remove(f)) continue;
        kept.push(f);
    }
    let total = kept.reduce((a, f) => a + f.size, 0);
    // 가장 최근 파일(지금 쓰고 있을 가능성이 큰 파일)은 한도를 넘어도 남긴다
    for (const f of kept.slice(0, -1)) {
        if (total <= maxTotalBytes) break;
        if (remove(f)) total -= f.size;
    }
    return { deleted };
}

module.exports = { datedLogName, appendLog, pruneLogs, DAY_MS, KEEP_DAYS };
