'use strict';
const net = require('net');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

/**
 * 테스트용 가짜 RTSP 카메라 (DESCRIBE만 처리).
 * - scheme: 'digest' | 'basic', qop: Digest qop=auth 사용 여부
 * - validPaths: 200을 돌려줄 경로 (쿼리 포함)
 * - unknownPathStatus: 인증 성공 후 없는 경로에 줄 코드. 404(대부분) 또는 401(일부 카메라)
 * - algorithms: 광고할 Digest algorithm 목록 (예: ['SHA-256'] 또는 ['SHA-256','MD5']). 챌린지마다 WWW-Authenticate 헤더 한 줄. 기본은 algorithm 생략
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
    host = '127.0.0.1',
    port = 0,
} = {}) {
    const state = { requests: [], failedAuth: 0 };
    const realm = 'mock';
    const nonce = 'abcdef123456';

    function challengeHeader() {
        if (scheme === 'basic') return `WWW-Authenticate: Basic realm="${realm}"\r\n`;
        const one = alg => `WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}"${alg ? `, algorithm=${alg}` : ''}${qop ? ', qop="auth"' : ''}\r\n`;
        return algorithms ? algorithms.map(one).join('') : one(null);
    }

    function checkAuth(header, method, uri) {
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
        socket.on('data', d => {
            buf += d.toString('latin1');
            if (!buf.includes('\r\n\r\n')) return;
            const lines = buf.split('\r\n');
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
                extra = challengeHeader();
            } else if (requireAuth && !checkAuth(auth, method, uri)) {
                code = 401;
                extra = challengeHeader();
                state.failedAuth++;
            } else if (pathOverrides[reqPath]) {
                code = pathOverrides[reqPath];
                if (code === 401) {
                    extra = challengeHeader();
                    state.failedAuth++;
                }
            } else if (!validPaths.includes(reqPath)) {
                code = unknownPathStatus;
                if (code === 401) {
                    extra = challengeHeader();
                    state.failedAuth++;
                }
            }
            state.requests.push({ method, path: reqPath, authed: !!auth, code });
            const reason = { 200: 'OK', 401: 'Unauthorized', 404: 'Not Found' }[code] || 'Error';
            const body = code === 200 ? 'v=0\r\n' : '';
            socket.end(`RTSP/1.0 ${code} ${reason}\r\nCSeq: 1\r\nServer: MockCam/1.0\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`);
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
