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

function sendRaw(host, port, request, timeoutMs) {
    return new Promise(resolve => {
        const chunks = [];
        let settled = false;
        const socket = net.connect({ host, port });
        const finish = result => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };
        const collected = () => Buffer.concat(chunks);
        socket.setTimeout(timeoutMs, () => (chunks.length ? finish({ ok: true, raw: collected() }) : finish({ ok: false, reason: 'timeout' })));
        socket.on('connect', () => socket.write(request));
        socket.on('data', d => {
            chunks.push(d);
            if (collected().toString('latin1').includes('\r\n\r\n')) finish({ ok: true, raw: collected() });
        });
        socket.on('end', () => finish(chunks.length ? { ok: true, raw: collected() } : { ok: false, reason: 'closed' }));
        socket.on('error', err => finish({ ok: false, reason: err.code || 'error' }));
    });
}

function buildRequest(uri, cseq, extraHeaders) {
    return `DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: CCTVGO-Finder\r\nAccept: application/sdp\r\n${extraHeaders}\r\n`;
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
    return { code: Number(m[1]), headers };
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

function buildAuthHeader(challenge, username, password, uri) {
    if (challenge.scheme === 'basic') {
        return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    const ha1 = md5(`${username}:${challenge.realm}:${password}`);
    const ha2 = md5(`DESCRIBE:${uri}`);
    let response;
    let extra = '';
    if (challenge.qop && /auth/.test(challenge.qop)) {
        const nc = '00000001';
        const cnonce = crypto.randomBytes(8).toString('hex');
        response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
        extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
        response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }
    const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : '';
    return `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"${extra}${opaque}`;
}

function classify(resp, authSent, extraHeaders) {
    let status = 'other';
    if (resp.code === 200) status = 'ok';
    else if (resp.code === 401) status = 'unauthorized';
    else if (resp.code === 404) status = 'not_found';
    return { status, code: resp.code, authSent, headers: { ...(extraHeaders || {}), ...resp.headers } };
}

async function describe({ host, port, path, username = '', password = '', timeoutMs = 2000 }) {
    // 요청 헤더/줄바꿈 주입 방지: 이런 아이디는 어떤 요청도 보내지 않는다
    if (INVALID_CREDENTIAL_RE.test(username)) return { status: 'other', code: 0, authSent: false, headers: {}, reason: 'invalid-credentials' };
    const uri = `rtsp://${host}:${port}${path.startsWith('/') ? path : '/' + path}`;

    const first = await sendRaw(host, port, buildRequest(uri, 1, ''), timeoutMs);
    if (!first.ok) return { status: 'unreachable', reason: first.reason, authSent: false };
    const r1 = parseResponse(first.raw);
    if (!r1) return { status: 'other', code: 0, authSent: false, headers: {} };
    if (r1.code !== 401 || !username) return classify(r1, false);

    const challenge = parseChallenge(r1.headers['www-authenticate']);
    if (!challenge) return classify(r1, false);

    // SHA-256/MD5-sess 등 지원하지 않는 방식은 틀린 응답을 보내 로그인 실패로 세이게 되므로 자격 증명을 보내지 않는다
    if (challenge.scheme === 'unsupported') return { ...classify(r1, false), status: 'other', reason: 'unsupported-auth' };

    const auth = buildAuthHeader(challenge, username, password, uri);
    const second = await sendRaw(host, port, buildRequest(uri, 2, `Authorization: ${auth}\r\n`), timeoutMs);
    if (!second.ok) return { status: 'unreachable', reason: second.reason, authSent: true };
    const r2 = parseResponse(second.raw);
    if (!r2) return { status: 'other', code: 0, authSent: true, headers: r1.headers };
    return classify(r2, true, r1.headers);
}

module.exports = { describe, parseChallenge };
