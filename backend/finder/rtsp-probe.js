'use strict';
const net = require('net');
const crypto = require('crypto');

/**
 * RTSP DESCRIBE 를 소켓으로 직접 보내 응답 코드를 분류한다.
 * - 200 ok / 401 unauthorized / 404 not_found / 그 외 other / 연결 실패 unreachable
 * - authSent: 아이디/비밀번호를 실어 보낸 요청의 결과인지 (인증 실패 예산 계산에 쓴다)
 */

const INVALID_CREDENTIAL_RE = /[\x00-\x1f\x7f"]/;
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

/**
 * 요청/응답을 차례로 주고받는 RTSP 연결.
 * Digest nonce 를 연결마다 새로 발급하는 카메라가 있어 401 다음의 인증 요청은 같은 연결로 보내야 한다.
 */
function openConnection(host, port) {
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let closedReason = null;
    let pending = null;   // { resolve, timer }

    const settle = result => {
        if (!pending) return;
        clearTimeout(pending.timer);
        const { resolve } = pending;
        pending = null;
        resolve(result);
    };
    /** 헤더(+Content-Length 만큼의 본문)가 다 오면 그 응답을 돌려준다 */
    const tryComplete = () => {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const m = /\r\ncontent-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('latin1'));
        const total = end + 4 + (m ? Number(m[1]) : 0);
        if (buf.length < total) return;
        const raw = buf.subarray(0, total);
        buf = Buffer.alloc(0);
        settle({ ok: true, raw });
    };
    const close = reason => {
        if (!closedReason) closedReason = reason;
        // 응답이 오다 끊기면 받은 만큼으로 해석해 본다
        settle(buf.length ? { ok: true, raw: buf } : { ok: false, reason: closedReason });
    };

    const connected = new Promise(resolve => {
        socket.on('connect', () => resolve(true));
        socket.on('error', err => { close(err.code || 'error'); resolve(false); });
    });
    socket.on('data', d => { buf = Buffer.concat([buf, d]); if (pending) tryComplete(); });
    socket.on('end', () => close('closed'));
    socket.on('close', () => close('closed'));

    return {
        get closed() { return closedReason !== null; },
        /** 요청 하나를 보내고 응답을 기다린다. 연결 대기 시간도 timeoutMs 에 포함된다 */
        send(request, timeoutMs) {
            if (closedReason) return Promise.resolve({ ok: false, reason: closedReason });
            return new Promise(resolve => {
                pending = {
                    resolve,
                    timer: setTimeout(() => settle(buf.length ? { ok: true, raw: buf } : { ok: false, reason: 'timeout' }), timeoutMs),
                };
                connected.then(ok => { if (ok && pending && !closedReason) socket.write(request); });
            });
        },
        destroy() { socket.destroy(); },
    };
}

function buildRequest(uri, cseq, extraHeaders, method = 'DESCRIBE') {
    const accept = method === 'DESCRIBE' ? 'Accept: application/sdp\r\n' : '';
    return `${method} ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: CCTVGO-Finder\r\n${accept}${extraHeaders}\r\n`;
}

function parseResponse(raw) {
    const text = raw.toString('latin1');
    const end = text.indexOf('\r\n\r\n');
    const lines = (end >= 0 ? text.slice(0, end) : text).split('\r\n');
    const m = /^RTSP\/\d\.\d\s+(\d{3})/.exec(lines[0] || '');
    if (!m) return null;
    const headers = {};
    for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    return { code: Number(m[1]), headers, body: end >= 0 ? text.slice(end + 4) : '' };
}

/** WWW-Authenticate 값(여러 줄은 ", "로 합쳐져 있다)을 챌린지별 문자열로 나눈다. 따옴표 안의 쉼표/단어는 무시한다. */
function splitChallenges(value) {
    const starts = [];
    let inQuote = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '"') inQuote = !inQuote;
        if (inQuote) continue;
        const atBoundary = i === 0 || /[,\s]/.test(value[i - 1]);
        if (atBoundary && /^[A-Za-z][\w-]*(\s|$)/.test(value.slice(i)) && !/^\w+=/.test(value.slice(i))) {
            // 스킴 이름(Digest/Basic/기타) 뒤에는 공백이 오고, 파라미터(key=value)와 구별한다
            const word = /^[A-Za-z][\w-]*/.exec(value.slice(i))[0];
            const prev = value.slice(0, i).trimEnd();
            if (i === 0 || prev.endsWith(',')) starts.push({ at: i, word });
        }
    }
    return starts.map((st, k) => ({
        scheme: st.word.toLowerCase(),
        body: value.slice(st.at + st.word.length, k + 1 < starts.length ? starts[k + 1].at : undefined).replace(/,\s*$/, ''),
    }));
}

/**
 * 사용할 챌린지를 고른다. 우선순위: algorithm 이 없거나 MD5 인 Digest(첫 번째) > Basic > 사용 불가.
 * 헤더가 없으면 null, 있는데 쓸 수 있는 것이 없으면 { scheme: 'unsupported' } (이때는 자격 증명을 보내면 안 된다).
 */
function parseChallenge(value) {
    if (!value) return null;
    const list = splitChallenges(value);
    if (list.length === 0) return null;
    for (const ch of list) {
        if (ch.scheme !== 'digest') continue;
        const params = {};
        const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
        let m;
        while ((m = re.exec(ch.body))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
        if (params.algorithm === undefined || /^md5$/i.test(params.algorithm)) return { scheme: 'digest', ...params };
    }
    const basic = list.find(ch => ch.scheme === 'basic');
    if (basic) {
        const m = /realm="?([^",]*)"?/i.exec(basic.body);
        return { scheme: 'basic', realm: m ? m[1] : '' };
    }
    return { scheme: 'unsupported' };
}

function buildAuthHeader(challenge, username, password, method, uri, count = 1) {
    if (challenge.scheme === 'basic') {
        return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    const ha1 = md5(`${username}:${challenge.realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response;
    let extra = '';
    if (challenge.qop && /auth/.test(challenge.qop)) {
        const nc = String(count).padStart(8, '0');
        const cnonce = crypto.randomBytes(8).toString('hex');
        response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
        extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
        response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }
    const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : '';
    return `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"${extra}${opaque}`;
}

/**
 * SETUP 할 주소: Content-Base(없으면 Content-Location, 요청 주소) 뒤에 첫 미디어의 a=control 을 붙인다.
 * ffmpeg 와 같은 방식이다 (상대 control 은 "/" 로 이어 붙인다).
 */
function setupUrl(resp, uri) {
    const base = resp.headers['content-base'] || resp.headers['content-location'] || uri;
    const media = resp.body.split(/\r?\n(?=m=)/).slice(1);
    const section = media.find(s => /^m=video/.test(s)) || media[0] || '';
    const m = /^a=control:\s*(\S+)/m.exec(section);
    const control = m ? m[1] : '*';
    if (/^rtsp:\/\//i.test(control)) return control;
    if (control === '*') return base;
    return base + (base.endsWith('/') ? '' : '/') + control;
}

/** SDP 의 첫 영상 트랙 코덱 (H264, H265 등). HEVC 표기는 H265 로 맞춘다. 영상 트랙이 없으면 null */
function parseVideoCodec(sdp) {
    const section = String(sdp || '').split(/\r?\n(?=m=)/).find(s => /^m=video/.test(s));
    if (!section) return null;
    const pt = (/^m=video\s+\S+\s+\S+\s+(\d+)/.exec(section) || [])[1];
    const m = (pt && new RegExp(`^a=rtpmap:${pt}\s+([^/\s]+)`, 'm').exec(section)) || /^a=rtpmap:\d+\s+([^/\s]+)/m.exec(section);
    if (!m) return null;
    const codec = m[1].toUpperCase();
    return codec === 'HEVC' ? 'H265' : codec;
}

function classify(resp, authSent, extraHeaders) {
    let status = 'other';
    if (resp.code === 200) status = 'ok';
    else if (resp.code === 401) status = 'unauthorized';
    else if (resp.code === 404) status = 'not_found';
    const result = { status, code: resp.code, authSent, headers: { ...(extraHeaders || {}), ...resp.headers } };
    if (resp.code === 200) result.codec = parseVideoCodec(resp.body);
    return result;
}

async function describe({ host, port, path, username = '', password = '', timeoutMs = 2000 }) {
    // 요청 헤더/줄바꿈 주입 방지: 이런 아이디는 어떤 요청도 보내지 않는다
    if (INVALID_CREDENTIAL_RE.test(username)) return { status: 'other', code: 0, authSent: false, headers: {}, reason: 'invalid-credentials' };
    const uri = `rtsp://${host}:${port}${path.startsWith('/') ? path : '/' + path}`;

    const conn = openConnection(host, port);
    let challenge = null;
    let cseq = 1;
    let nc = 0;   // Digest qop=auth 의 nonce 사용 횟수 (같은 nonce 로 보낼 때마다 1 증가)

    /**
     * DESCRIBE 200 은 "경로가 있다"는 증거가 못 된다 (계정만 맞으면 아무 경로에나 200 을 주는 카메라가 있다).
     * 같은 연결로 SETUP 까지 보내 실제로 재생 준비가 되는지 확인한다.
     * 연결이 이미 닫혔으면(Connection: close) 세션 없이 SETUP 할 수 없으므로 DESCRIBE 결과를 그대로 쓴다.
     */
    async function verifySetup(c, resp, result) {
        if (c.closed || /close/i.test(resp.headers.connection || '')) return result;
        const url = setupUrl(resp, uri);
        const auth = challenge ? `Authorization: ${buildAuthHeader(challenge, username, password, 'SETUP', url, ++nc)}\r\n` : '';
        cseq++;
        const setup = await c.send(buildRequest(url, cseq, `Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n${auth}`, 'SETUP'), timeoutMs);
        const rs = setup.ok ? parseResponse(setup.raw) : null;
        // 461 Unsupported Transport: 경로는 이해했고 TCP 전송만 거절한 것이다 (UDP 전용 카메라, ffmpeg 는 UDP 로 재시도해 재생한다)
        if (!rs || (rs.code !== 200 && rs.code !== 461)) {
            const code = rs ? rs.code : 0;
            return { ...result, status: 'setup_failed', code, authAccepted: result.authSent, reason: setup.ok ? undefined : setup.reason };
        }
        // TEARDOWN 은 보내지 않는다: 경로를 모르는 요청에 401 을 주는 카메라는 이것도 로그인 실패로 셀 수 있다.
        // 연결을 끊으면 세션이 정리되고, 아니어도 세션 타임아웃으로 사라진다
        return result;
    }

    try {
        const first = await conn.send(buildRequest(uri, cseq, ''), timeoutMs);
        if (!first.ok) return { status: 'unreachable', reason: first.reason, authSent: false };
        const r1 = parseResponse(first.raw);
        if (!r1) return { status: 'other', code: 0, authSent: false, headers: {} };
        if (r1.code === 200) return await verifySetup(conn, r1, classify(r1, false));
        if (r1.code !== 401 || !username) return classify(r1, false);

        challenge = parseChallenge(r1.headers['www-authenticate']);
        if (!challenge) return classify(r1, false);

        // SHA-256/MD5-sess 등 지원하지 않는 방식은 틀린 응답을 보내 로그인 실패로 세이게 되므로 자격 증명을 보내지 않는다
        if (challenge.scheme === 'unsupported') return { ...classify(r1, false), status: 'other', reason: 'unsupported-auth' };

        // 같은 연결로 보낸다 (nonce 가 연결에 묶인 카메라). 카메라가 401 뒤에 연결을 닫았다면 새 연결로 보낸다
        cseq++;
        const request = buildRequest(uri, cseq, `Authorization: ${buildAuthHeader(challenge, username, password, 'DESCRIBE', uri, ++nc)}\r\n`);
        const reconnect = conn.closed || /close/i.test(r1.headers.connection || '');
        const c = reconnect ? openConnection(host, port) : conn;
        try {
            const second = await c.send(request, timeoutMs);
            if (!second.ok) return { status: 'unreachable', reason: second.reason, authSent: true };
            const r2 = parseResponse(second.raw);
            if (!r2) return { status: 'other', code: 0, authSent: true, headers: r1.headers };
            const result = classify(r2, true, r1.headers);
            return r2.code === 200 ? await verifySetup(c, r2, result) : result;
        } finally {
            if (reconnect) c.destroy();
        }
    } finally {
        conn.destroy();
    }
}

module.exports = { describe, parseChallenge, parseVideoCodec };
