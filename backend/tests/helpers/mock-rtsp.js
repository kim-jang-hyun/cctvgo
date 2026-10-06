'use strict';
const net = require('net');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const TRACK = 'track1';

/**
 * 테스트용 가짜 RTSP 카메라 (DESCRIBE 와 SETUP 처리). DESCRIBE 200 에는 SDP(Content-Base + control:track1)를 준다.
 * - scheme: 'digest' | 'basic', qop: Digest qop=auth 사용 여부
 * - validPaths: 200을 돌려줄 경로 (쿼리 포함)
 * - unknownPathStatus: 인증 성공 후 없는 경로에 줄 코드. 404(대부분) 또는 401(일부 카메라)
 * - algorithms: 광고할 Digest algorithm 목록 (예: ['SHA-256'] 또는 ['SHA-256','MD5']). 챌린지마다 WWW-Authenticate 헤더 한 줄. 기본은 algorithm 생략
 * - 연결은 기본으로 유지한다 (실제 카메라처럼 한 연결에서 여러 요청을 받는다)
 * - connectionNonce: true 면 nonce 를 연결마다 새로 발급한다 (다른 연결의 nonce 는 거절)
 * - state.failedAuth: 카메라 입장에서 "로그인 실패"로 셀 수 있는 401 횟수
 */
async function createMockRtsp({
    users = { admin: 'pw' },
    scheme = 'digest',
    qop = false,
    validPaths = ['/stream1'],
    unknownPathStatus = 404,
    pathOverrides = {}, // 특정 경로에 줄 코드 (인증 성공 후). 예: { '/a': 401 }
    requireAuth = true,
    algorithms = null,
    dropAuthed = false, // true 면 Authorization 을 실은 요청에는 응답 없이 연결을 끊는다
    garbleAuthed = false, // true 면 Authorization 을 실은 요청에 RTSP 가 아닌 응답을 준다
    connectionNonce = false,
    closeAfterResponse = false, // true 면 응답마다 Connection: close 를 붙이고 연결을 닫는다
    unknownSetupStatus = 200, // validPaths 에 없는 경로의 SETUP 에 줄 코드 (DESCRIBE 는 아무 경로나 받고 SETUP 에서 거절하는 카메라는 400)
    setupStatus = 200, // validPaths 경로의 SETUP 에 줄 코드 (UDP 만 지원해 TCP 전송을 거절하는 카메라는 461)
    host = '127.0.0.1',
    port = 0,
} = {}) {
    const state = { requests: [], failedAuth: 0 };
    const realm = 'mock';
    const fixedNonce = 'abcdef123456';

    function challengeHeader(nonce) {
        if (scheme === 'basic') return `WWW-Authenticate: Basic realm="${realm}"\r\n`;
        const one = alg => `WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}"${alg ? `, algorithm=${alg}` : ''}${qop ? ', qop="auth"' : ''}\r\n`;
        return algorithms ? algorithms.map(one).join('') : one(null);
    }

    function checkAuth(header, method, uri, nonce) {
        if (/^basic /i.test(header)) {
            const decoded = Buffer.from(header.slice(6), 'base64').toString();
            const i = decoded.indexOf(':');
            const user = decoded.slice(0, i);
            return users[user] !== undefined && users[user] === decoded.slice(i + 1);
        }
        const f = key => {
            const m = new RegExp(`(?:^|[\\s,])${key}="?([^",]*)"?`).exec(header);
            return m ? m[1] : null;
        };
        const user = f('username');
        if (!user || users[user] === undefined || f('nonce') !== nonce) return false;
        const ha1 = md5(`${user}:${realm}:${users[user]}`);
        const ha2 = md5(`${method}:${uri}`);
        const expected = qop
            ? md5(`${ha1}:${nonce}:${f('nc')}:${f('cnonce')}:auth:${ha2}`)
            : md5(`${ha1}:${nonce}:${ha2}`);
        return f('response') === expected;
    }

    const server = net.createServer(socket => {
        let buf = '';
        const nonce = connectionNonce ? crypto.randomBytes(16).toString('hex') : fixedNonce;
        socket.on('data', d => {
            buf += d.toString('latin1');
            if (!buf.includes('\r\n\r\n')) return;
            const lines = buf.split('\r\n');
            buf = '';
            const [method, uri] = lines[0].split(' ');
            const headers = {};
            for (const l of lines.slice(1)) {
                const i = l.indexOf(':');
                if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
            }
            const u = new URL(uri);
            const reqPath = u.pathname + u.search;
            const auth = headers['authorization'];
            if (auth && dropAuthed) { state.requests.push({ method, path: reqPath, authed: true, code: 0 }); return socket.destroy(); }
            if (auth && garbleAuthed) { state.requests.push({ method, path: reqPath, authed: true, code: 0 }); return socket.end('HTTP/1.1 200 nope\r\n\r\n'); }

            let code = 200;
            let extra = '';
            if (requireAuth && !auth) {
                code = 401;
                extra = challengeHeader(nonce);
            } else if (requireAuth && !checkAuth(auth, method, uri, nonce)) {
                code = 401;
                extra = challengeHeader(nonce);
                state.failedAuth++;
            } else if (method === 'SETUP') {
                // DESCRIBE 의 Content-Base + 트랙 control 로 만든 주소. 원래 경로가 실제로 있어야 재생 준비가 된다
                const streamPath = reqPath.endsWith(`/${TRACK}`) ? reqPath.slice(0, -TRACK.length - 1) : null;
                if (streamPath === null) code = 400;
                else code = validPaths.includes(streamPath) ? setupStatus : unknownSetupStatus;
                if (code === 200) extra = 'Session: 12345678;timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n';
            } else if (pathOverrides[reqPath]) {
                code = pathOverrides[reqPath];
                if (code === 401) {
                    extra = challengeHeader(nonce);
                    state.failedAuth++;
                }
            } else if (!validPaths.includes(reqPath)) {
                code = unknownPathStatus;
                if (code === 401) {
                    extra = challengeHeader(nonce);
                    state.failedAuth++;
                }
            }
            state.requests.push({ method, path: reqPath, authed: !!auth, code });
            const reason = { 200: 'OK', 401: 'Unauthorized', 404: 'Not Found' }[code] || 'Error';
            const sdp = `v=0\r\no=- 0 0 IN IP4 ${host}\r\ns=Mock\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:${TRACK}\r\n`;
            const body = code === 200 && method === 'DESCRIBE' ? sdp : '';
            if (body) extra += `Content-Type: application/sdp\r\nContent-Base: ${uri}/\r\n`;
            const response = `RTSP/1.0 ${code} ${reason}\r\nCSeq: 1\r\nServer: MockCam/1.0\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`;
            if (closeAfterResponse) socket.end(response.replace('CSeq: 1\r\n', 'CSeq: 1\r\nConnection: close\r\n'));
            else socket.write(response);
        });
        socket.on('error', () => {});
    });

    await new Promise(resolve => server.listen(port, host, resolve));
    return {
        port: server.address().port,
        state,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = { createMockRtsp };
