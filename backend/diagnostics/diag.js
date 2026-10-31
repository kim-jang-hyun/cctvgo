'use strict';
const fs = require('fs');
const path = require('path');
const { appendLog } = require('./log-files');

/**
 * 연결 실패와 운용 기록. 고객 PC 의 logs 폴더에만 남긴다 (로그 수집 서버 없음).
 * 고객이 문의할 때 설정 화면의 "진단 정보 복사"로 text() 를 보내게 한다. UPnP 같은 기능 추가의 근거가 된다.
 * - connections-YYYY-MM-DD.log: 연결 시도 한 건씩 (한 줄 JSON). 날짜별 파일이고 30일 지나면 지운다 (log-files.js)
 * - connection-stats.json: 누적 통계 (.json 이라 7일 삭제 대상이 아니다)
 * - cctvgo-events-YYYY-MM-DD.log: go2rtc 재시작, 방화벽 결과, 선택된 변환기 등
 * 카메라 주소와 비밀번호는 남기지 않는다(카메라는 번호만). 시청자 IP 는 앞 두 자리만 남긴다.
 */

const RECENT_MAX = 50;
// 기록에 남기는 필드 (그 밖의 값은 버린다: 실수로 카메라 주소 등이 섞여도 남지 않게)
const FIELDS = ['stage', 'k', 'ok', 'variant', 'reason', 'h265', 'ms', 'status', 'local', 'pair', 'error'];

function maskIp(ip) {
    const s = String(ip || '').trim().replace(/^::ffff:/i, '');
    if (!s) return '알 수 없음';
    const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s);
    if (v4) return `${v4[1]}.${v4[2]}.x.x`;
    if (s.includes(':')) return s.split(':').slice(0, 2).join(':') + ':x';
    return '알 수 없음';
}

function emptyStage() {
    return { ok: 0, fail: 0, reasons: {}, pairs: {}, variants: {} };
}

function createDiag({ logDir, now = Date.now, version = '' }) {
    const statsPath = path.join(logDir, 'connection-stats.json');
    const startedAt = new Date(now()).toISOString();
    const recent = [];
    const recentEvents = [];
    let envResult = null;
    let stats = { since: startedAt, browser: emptyStage(), signaling: emptyStage() };
    try {
        const saved = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        if (saved && saved.browser && saved.signaling) stats = saved;
    } catch (e) { /* 처음이거나 깨진 파일이면 새로 시작 */ }

    function connection(evt) {
        const rec = { t: new Date(now()).toISOString() };
        for (const f of FIELDS) if (evt[f] !== undefined && evt[f] !== null) rec[f] = evt[f];
        rec.ip = maskIp(evt.ip);
        if (evt.ua) rec.ua = String(evt.ua).slice(0, 160);
        appendLog(logDir, 'connections', JSON.stringify(rec), now);
        recent.push(rec);
        if (recent.length > RECENT_MAX) recent.shift();

        const st = stats[rec.stage === 'signaling' ? 'signaling' : 'browser'];
        if (rec.ok) st.ok++; else st.fail++;
        if (rec.reason) st.reasons[rec.reason] = (st.reasons[rec.reason] || 0) + 1;
        if (rec.variant) st.variants[rec.variant] = (st.variants[rec.variant] || 0) + 1;
        if (rec.pair && rec.pair.local) {
            const key = `${rec.pair.local}-${rec.pair.remote}`;
            st.pairs[key] = (st.pairs[key] || 0) + 1;
        }
        try {
            fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(statsPath, JSON.stringify(stats, null, 1), 'utf8');
        } catch (e) { /* 무시 */ }
    }

    function event(kind, detail = {}) {
        const rec = { t: new Date(now()).toISOString(), kind, ...detail };
        appendLog(logDir, 'cctvgo-events', JSON.stringify(rec), now);
        recentEvents.push(rec);
        if (recentEvents.length > RECENT_MAX) recentEvents.shift();
    }

    function env(result) {
        envResult = { t: new Date(now()).toISOString(), ...result };
        event('environment', result);
    }

    function summary() {
        return stats;
    }

    function text() {
        const lines = [
            'CCTVGO 진단 정보 (문의 시 함께 보내 주세요. 카메라 주소와 비밀번호는 포함되지 않습니다)',
            `버전: ${version || '알 수 없음'}`,
            `서비스 시작: ${startedAt}`,
            '',
            '[환경 점검]',
            envResult ? JSON.stringify(envResult) : '아직 점검 전',
            '',
            '[운용 기록 (최근)]',
            ...(recentEvents.length ? recentEvents.map(e => JSON.stringify(e)) : ['없음']),
            '',
            '[연결 통계 (누적)]',
            JSON.stringify(stats),
            '',
            `[최근 연결 ${recent.length}건]`,
            ...(recent.length ? recent.map(r => JSON.stringify(r)) : ['없음']),
        ];
        return lines.join('\n');
    }

    return { connection, event, env, summary, text };
}

module.exports = { createDiag, maskIp };
