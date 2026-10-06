'use strict';
const { describe } = require('./rtsp-probe');
const onvif = require('./onvif');
const { tcpOpen, RTSP_PORTS } = require('./scan');
const { buildRtspUrl } = require('./cctv-file');
const { orderedPaths } = require('./paths');

/**
 * 카메라 RTSP URL 탐색 오케스트레이션.
 *
 * 순서: ONVIF GetStreamUri(재검증) → 존재하지 않는 경로로 카메라 성향 감지 → 경로 후보 DESCRIBE
 *
 * 계정 잠금 방지 (budget = AuthBudget, IP별 인증 실패 2회):
 * - 아이디/비밀번호를 실어 보낸 요청이 401이면 실패 1회로 센다 (ONVIF NotAuthorized 포함).
 * - 성향 감지: 없는 경로에 404 → 계정은 맞고 이후 401은 비밀번호 오류로 확정(즉시 중단).
 *              없는 경로에 401 → 비밀번호 오류이거나 "경로가 틀려도 401을 주는" 카메라. 예산 안에서만 계속.
 */

const BOGUS_PATH = '/cctvgo-probe-test';

function buildDiagnostics(host, vendorHint, info, tried) {
    return [
        'CCTVGO 카메라 주소 찾기 진단 정보',
        `카메라 IP: ${host}`,
        `제조사/모델 힌트: ${vendorHint || '알 수 없음'}`,
        `열린 RTSP 포트: ${info.openPorts.length ? info.openPorts.join(', ') : '없음'}`,
        `RTSP Server 헤더: ${info.server || '알 수 없음'}`,
        `RTSP 인증 realm: ${info.realm || '알 수 없음'}`,
        `ONVIF: ${info.onvif}`,
        `시도한 항목 (${tried.length}개):`,
        ...tried.map(t => `  - [${t.kind}] ${t.target} → ${t.result}`),
    ].join('\n');
}

async function findStream({
    host, port, path, username = '', password = '', vendorHint = '',
    budget, settings, rtspPorts = RTSP_PORTS, rtspTimeoutMs = 2000, onvifTimeoutMs = 3000,
}) {
    const tried = [];
    const info = { server: null, realm: null, onvif: '시도 안 함', openPorts: [] };

    const finish = (status, extra = {}) => {
        const result = { status, candidates: [], tried, diagnostics: buildDiagnostics(host, vendorHint, info, tried), ...extra };
        // 예산이 소진돼 끝난 경우 언제 다시 시도할 수 있는지 알려 준다
        if (status === 'auth_failed' && budget.isExhausted(host)) result.retryAfterSec = Math.ceil(budget.retryAfterMs(host) / 1000);
        return result;
    };
    // 카메라가 지원하지 않는 로그인 방식(Digest SHA-256 등)이면 자격 증명을 보내지 않았으므로 예산 소모 없이 바로 끝낸다
    const unsupported = r => r.reason === 'unsupported-auth';
    const finishUnsupported = () => finish('auth_failed', { ambiguous: true, authUnsupported: true });
    const candidate = (rtspPort, p, source, label) => ({
        url: buildRtspUrl({ username, password, host, port: rtspPort, path: p }), source, label,
    });

    function noteHeaders(h) {
        if (!h) return;
        if (h.server) info.server = h.server;
        const m = /realm="([^"]*)"/i.exec(h['www-authenticate'] || '');
        if (m) info.realm = m[1];
    }

    /** DESCRIBE 1회. 로그인 실패(401)는 예산에 기록하고, 인증에 성공하면 예산을 초기화한다. */
    async function attempt(rtspPort, p) {
        const r = await describe({ host, port: rtspPort, path: p, username, password, timeoutMs: rtspTimeoutMs });
        const result = r.status === 'unreachable' ? `연결 실패(${r.reason})`
            : r.status === 'setup_failed' ? `200, SETUP ${r.code || r.reason || '실패'}` : String(r.code);
        tried.push({ kind: 'rtsp', target: `${rtspPort}${p}`, result });
        noteHeaders(r.headers);
        // 자격 증명을 보냈는데 성공/404(=인증은 통과)가 아니면 카메라가 로그인 실패로 셌을 수 있으니 보수적으로 1회 센다
        // (401뿐 아니라 응답 없음/연결 끊김/해석 불가 포함). DESCRIBE 는 통과하고 SETUP 만 거절된 경우는 계정이 맞으므로
        // 세지 않는다 (SETUP 이 401 이면 보수적으로 센다)
        const authPassed = r.status === 'ok' || r.status === 'not_found' || (r.status === 'setup_failed' && r.authAccepted && r.code !== 401);
        if (r.authSent && authPassed) budget.reset(host);
        else if (r.authSent) budget.recordFailure(host);
        return r;
    }

    async function openRtspPorts() {
        const open = [];
        for (const p of rtspPorts) {
            if (await tcpOpen(host, p, 500)) open.push(p);
        }
        info.openPorts = open;
        return open;
    }

    if (budget.isExhausted(host)) {
        return finish('auth_locked', { retryAfterSec: Math.ceil(budget.retryAfterMs(host) / 1000) });
    }

    // --- 직접 입력한 경로 ---
    if (path) {
        const normalized = path.startsWith('/') ? path : '/' + path;
        const ports = port ? [port] : await openRtspPorts();
        if (ports.length === 0) return finish('unreachable');
        const r = await attempt(ports[0], normalized);
        if (unsupported(r)) return finishUnsupported();
        if (r.status === 'ok') return finish('found', { candidates: [candidate(ports[0], normalized, 'manual', normalized)] });
        if (r.status === 'unreachable') return finish('unreachable');
        if (r.status === 'unauthorized') return finish('auth_failed', { ambiguous: true });
        return finish('path_not_found');
    }

    // --- 1) ONVIF (계정이 없으면 시도하지 않는다: 빈 계정도 카메라에는 로그인 실패로 보인다) ---
    const on = username
        ? await onvif.getStreamUris({
            host, username, password, ports: settings.onvifPorts, servicePaths: settings.onvifServicePaths, timeoutMs: onvifTimeoutMs,
        })
        : { status: 'skipped' };
    info.onvif = on.status === 'ok' ? `응답함 (프로파일 ${on.uris.length}개)` : on.status === 'auth_failed' ? '응답함, 인증 실패'
        : on.status === 'skipped' ? '시도 안 함 (계정 없음)' : '응답 없음 또는 미지원';
    if (on.status !== 'skipped') tried.push({ kind: 'onvif', target: host, result: on.status });

    if (on.status === 'ok') {
        const verified = [];
        for (const item of on.uris) {
            if (budget.isExhausted(host)) break;
            let u;
            try { u = new URL(item.uri); } catch (e) { continue; }
            const rtspPort = Number(u.port) || 554;
            const p = (u.pathname || '/') + (u.search || '');
            const r = await attempt(rtspPort, p);   // 카메라가 알려 준 주소라도 실제 접속을 확인한다
            if (unsupported(r)) return finishUnsupported();
            if (r.status === 'ok') verified.push(candidate(rtspPort, p, 'onvif', item.name || item.token));
            else if (r.status === 'unreachable') break;
        }
        if (verified.length) return finish('found', { candidates: verified });
    } else if (on.status === 'auth_failed') {
        budget.recordFailure(host);
        if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: false });
    }

    // --- 2) 경로 후보 ---
    const ports = port ? [port] : await openRtspPorts();
    if (ports.length === 0) return finish('unreachable');
    const rtspPort = ports[0];
    if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: true });

    const bogus = await attempt(rtspPort, BOGUS_PATH);
    if (unsupported(bogus)) return finishUnsupported();
    if (bogus.status === 'unreachable') return finish('unreachable');
    if (bogus.status === 'unauthorized' && !username) {
        return finish('auth_failed', { ambiguous: false });
    }
    // 없는 경로가 SETUP 까지 되는 카메라: 아무 경로나 재생된다. 확인용 경로 대신 실제 경로 후보를 찾아 저장하고, 없으면 확인용 경로를 쓴다
    const acceptsAnyPath = bogus.status === 'ok';
    // 계정이 맞다는 증거: 없는 경로에 404, 또는 DESCRIBE 는 통과(SETUP 만 거절)하거나 재생까지 된 경우 (403/500/해석 불가는 증거 아님)
    const strict = bogus.status === 'not_found' || acceptsAnyPath
        || (bogus.status === 'setup_failed' && bogus.authAccepted && bogus.code !== 401);

    for (const p of orderedPaths(settings, vendorHint)) {
        if (budget.isExhausted(host)) return finish('auth_failed', { ambiguous: true });
        const r = await attempt(rtspPort, p);
        if (unsupported(r)) return finishUnsupported();
        if (r.status === 'ok') return finish('found', { candidates: [candidate(rtspPort, p, 'path', p)] });
        if (r.status === 'unreachable') return finish('unreachable');
        if (r.status === 'unauthorized' && strict) return finish('auth_failed', { ambiguous: false });
    }
    if (acceptsAnyPath && !budget.isExhausted(host)) {
        return finish('found', { candidates: [candidate(rtspPort, BOGUS_PATH, 'path', '(모든 경로에 응답하는 카메라)')] });
    }
    return budget.isExhausted(host) ? finish('auth_failed', { ambiguous: true }) : finish('path_not_found');
}

module.exports = { findStream, BOGUS_PATH };
