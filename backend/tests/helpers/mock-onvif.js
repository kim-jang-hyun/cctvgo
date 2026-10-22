'use strict';
const http = require('http');
const crypto = require('crypto');

/**
 * 테스트용 가짜 ONVIF 카메라 (device_service / media_service).
 * - clockOffsetMs: 카메라 시계가 서버보다 얼마나 앞서는지. WS-Security Created 가 maxSkewMs 를 넘으면 거절한다.
 * - GetProfiles / GetStreamUri 는 인증 필수(requireAuth). 실패하면 NotAuthorized Fault (state.failedAuth 증가)
 * - 스트림 주소는 일부러 rtsp://0.0.0.0:<rtspPort>/... 로 돌려준다 (실제 카메라의 잘못된 주소 재현)
 */
async function createMockOnvif({
    users = { admin: 'pw' },
    requireAuth = true,
    anonymousProfiles = false, // true 면 GetProfiles 는 인증 없이 허용하고 GetStreamUri 만 인증을 요구한다
    clockOffsetMs = 0,
    maxSkewMs = 5000,
    rtspPort = 554,
    profiles = [
        { token: 'p1', name: 'main', path: '/onvif/profile1' },
        { token: 'p2', name: 'sub', path: '/onvif/profile2' },
    ],
    host = '127.0.0.1',
    faultText = 'Sender not Authorized', // NotAuthorized 가 없는 비표준 문구를 주려면 바꾼다 (예: 'Authentication failed for user')
    canonicalFault = true,               // false 면 ter:NotAuthorized 코드 없이 faultText 만 담은 Fault 를 돌려준다
    mediaPaths = ['/onvif/media_service'], // 미디어 요청(GetProfiles/GetStreamUri)에 응답하는 경로. 그 외 경로는 404
    capsMediaPath = '/onvif/media_service', // GetCapabilities 의 Media XAddr 경로
    httpAuthChallenge = false, // true 면 자격 증명 없는 요청은 장치 시각/Capabilities 외에 경로와 관계없이 HTTP 401(HTML)로 거절한다 (실기 FX327)
} = {}) {
    // failedAuth: 자격 증명(Security 헤더)을 실은 요청이 거절된 횟수 / credentialed: 자격 증명을 실은 GetProfiles·GetStreamUri 횟수
    const state = { requests: [], failedAuth: 0, credentialed: 0 };
    const wrap = inner => '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        + 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
        + `xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${inner}</s:Body></s:Envelope>`;
    const notAuthorized = () => wrap('<s:Fault><s:Code><s:Value>s:Sender</s:Value>'
        + (canonicalFault ? '<s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode>' : '') + '</s:Code>'
        + `<s:Reason><s:Text xml:lang="en">${faultText}</s:Text></s:Reason></s:Fault>`);

    function authorized(body) {
        const pick = tag => {
            const m = new RegExp(`<(?:\\w+:)?${tag}(?=[\\s>])[^>]*>([^<]*)<`).exec(body);
            return m ? m[1] : null;
        };
        const user = pick('Username');
        const digest = pick('Password');
        const nonce = pick('Nonce');
        const created = pick('Created');
        if (!user || !digest || !nonce || !created || users[user] === undefined) return false;
        const expected = crypto.createHash('sha1')
            .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(users[user])]))
            .digest('base64');
        if (expected !== digest) return false;
        return Math.abs(Date.parse(created) - (Date.now() + clockOffsetMs)) <= maxSkewMs;
    }

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const op = (/<(?:\w+:)?(GetSystemDateAndTime|GetCapabilities|GetProfiles|GetStreamUri)\b/.exec(body) || [])[1];
            const authed = /<(?:\w+:)?UsernameToken\b/.test(body);
            state.requests.push({ path: req.url, op, authed });
            const deviceInfo = req.url === '/onvif/device_service' && (op === 'GetSystemDateAndTime' || op === 'GetCapabilities');
            if (httpAuthChallenge && !deviceInfo && !authed) {
                res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="IP Camera(FX327)", nonce="abc", stale="FALSE"', 'Content-Type': 'text/html' });
                return res.end('<html><head><title>Document Error: Unauthorized</title></head><body><h2>Access Error: 401 -- Unauthorized</h2></body></html>');
            }
            if (req.method !== 'POST' || !['/onvif/device_service', ...mediaPaths].includes(req.url) || !op) {
                res.writeHead(404);
                return res.end();
            }
            const send = (code, xml) => {
                res.writeHead(code, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
                res.end(xml);
            };
            if (op === 'GetSystemDateAndTime') {
                const d = new Date(Date.now() + clockOffsetMs);
                return send(200, wrap('<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>'
                    + `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`
                    + `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>`
                    + '</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'));
            }
            if (op === 'GetCapabilities') {
                return send(200, wrap('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media>'
                    + `<tt:XAddr>http://0.0.0.0:${server.address().port}${capsMediaPath}</tt:XAddr>`
                    + '</tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>'));
            }
            const hasCredentials = /<(?:\w+:)?UsernameToken\b/.test(body);
            if (hasCredentials) state.credentialed++;
            if (requireAuth && !(anonymousProfiles && op === 'GetProfiles') && !authorized(body)) {
                if (hasCredentials) state.failedAuth++;   // 자격 증명 없이 온 요청은 로그인 실패가 아니다
                return send(400, notAuthorized());
            }
            if (op === 'GetProfiles') {
                const items = profiles.map(p => `<trt:Profiles token="${p.token}" fixed="true"><tt:Name>${p.name}</tt:Name>`
                    + '<tt:VideoSourceConfiguration token="v1"><tt:Name>vsrc</tt:Name></tt:VideoSourceConfiguration></trt:Profiles>').join('');
                return send(200, wrap(`<trt:GetProfilesResponse>${items}</trt:GetProfilesResponse>`));
            }
            const token = (/<(?:\w+:)?ProfileToken>([^<]+)</.exec(body) || [])[1];
            const profile = profiles.find(p => p.token === token);
            if (!profile) return send(400, wrap('<s:Fault><s:Reason><s:Text>NoProfile</s:Text></s:Reason></s:Fault>'));
            return send(200, wrap('<trt:GetStreamUriResponse><trt:MediaUri>'
                + `<tt:Uri>rtsp://0.0.0.0:${rtspPort}${profile.path}</tt:Uri>`
                + '</trt:MediaUri></trt:GetStreamUriResponse>'));
        });
    });

    await new Promise(resolve => server.listen(0, host, resolve));
    return {
        port: server.address().port,
        state,
        close: () => new Promise(resolve => { server.close(resolve); if (server.closeAllConnections) server.closeAllConnections(); }),
    };
}

module.exports = { createMockOnvif };
