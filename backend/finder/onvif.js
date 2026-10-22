'use strict';
const http = require('http');
const crypto = require('crypto');
const { tcpOpen } = require('./scan');

/**
 * ONVIF 유니캐스트 SOAP 로 스트림 URI를 받아온다.
 * - 인증이 필요한 요청(GetProfiles/GetStreamUri)은 WS-Security UsernameToken(PasswordDigest)를 쓴다.
 * - 카메라와 서버의 시계 오차는 GetSystemDateAndTime 으로 보정한다.
 * - 자격 증명은 자격 증명 없이 존재가 확인된 (포트, 서비스 경로, 미디어 경로) 하나에만 보내고,
 *   그 요청이 명확한 성공이 아니면(어떤 Fault 든, 타임아웃이든) 즉시 auth_failed 로 끝낸다 (계정 잠금 방지).
 * - 계정(username)이 비어 있으면 자격 증명 요청 없이 unsupported.
 * - 자격 증명 없이 SOAP 응답이 오지 않는 경로/포트(404, 비 SOAP)는 건너뛰고, 끝까지 없으면 unsupported.
 *   단, Capabilities 가 알려 준 미디어 경로의 HTTP 401 은 존재하는 경로로 본다.
 */

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
    + 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"';

const xmlEscape = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const decodeXml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function securityHeader(username, password, offsetMs) {
    const nonce = crypto.randomBytes(16);
    const created = new Date(Date.now() + offsetMs).toISOString().split('.')[0] + 'Z';
    const digest = crypto.createHash('sha1')
        .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
        .digest('base64');
    return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        + `<UsernameToken><Username>${xmlEscape(username)}</Username>`
        + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
        + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
        + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
        + '</UsernameToken></Security></s:Header>';
}

function soapRequest({ host, port, path, body, auth, offsetMs = 0, timeoutMs = 3000 }) {
    return new Promise(resolve => {
        const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope ${NS}>`
            + `${auth ? securityHeader(auth.username, auth.password, offsetMs) : ''}<s:Body>${body}</s:Body></s:Envelope>`;
        const req = http.request({
            host, port, path, method: 'POST', timeout: timeoutMs,
            headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(envelope) },
        }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve({ ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        req.on('error', err => resolve({ ok: false, reason: err.code || 'error' }));
        req.end(envelope);
    });
}

const isEnvelope = text => /<(?:\w+:)?Envelope\b/i.test(text);
const isFault = text => /<(?:\w+:)?Fault\b/i.test(text);

/** 카메라 UTC 시각 - 서버 시각 (ms). 파싱할 수 없으면 null */
function parseUtcOffset(xml) {
    const block = /<(?:\w+:)?UTCDateTime[\s\S]*?<\/(?:\w+:)?UTCDateTime>/.exec(xml);
    if (!block) return null;
    const get = tag => {
        const m = new RegExp(`<(?:\\w+:)?${tag}>(\\d+)<`).exec(block[0]);
        return m ? Number(m[1]) : null;
    };
    const [y, mo, d, h, mi, s] = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(get);
    if ([y, mo, d, h, mi, s].some(v => v === null)) return null;
    return Date.UTC(y, mo - 1, d, h, mi, s) - Date.now();
}

function parseProfiles(xml) {
    return xml.split(/<(?:\w+:)?Profiles\b/).slice(1).map(chunk => {
        const token = (/token="([^"]+)"/.exec(chunk) || [])[1];
        const name = (/<(?:\w+:)?Name>([^<]*)</.exec(chunk) || [])[1];
        return token ? { token: decodeXml(token), name: decodeXml(name || '') } : null;
    }).filter(Boolean);
}

function parseUri(xml) {
    const m = /<(?:\w+:)?Uri>([^<]+)</.exec(xml);
    return m ? decodeXml(m[1].trim()) : null;
}

async function tryEndpoint({ host, port, servicePath, username, password, timeoutMs }) {
    const time = await soapRequest({ host, port, path: servicePath, body: '<tds:GetSystemDateAndTime/>', timeoutMs });
    if (!time.ok || !isEnvelope(time.text)) return { status: 'unsupported' };
    const parsedOffset = parseUtcOffset(time.text);
    const offsetMs = parsedOffset === null ? 0 : parsedOffset;

    // 미디어 서비스 경로: Capabilities 의 XAddr 경로만 사용한다 (호스트는 무시하고 항상 요청한 IP/포트 사용)
    const mediaPaths = [];
    let capsMediaPath = null;
    const caps = await soapRequest({
        host, port, path: servicePath, timeoutMs,
        body: '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
    });
    if (caps.ok && isEnvelope(caps.text)) {
        const m = /<(?:\w+:)?Media>[\s\S]*?<(?:\w+:)?XAddr>([^<]+)</.exec(caps.text);
        if (m) {
            try {
                capsMediaPath = new URL(decodeXml(m[1].trim())).pathname;
                mediaPaths.push(capsMediaPath);
            } catch (e) { /* 무시 */ }
        }
    }
    for (const p of ['/onvif/media_service', '/onvif/media', servicePath]) {
        if (!mediaPaths.includes(p)) mediaPaths.push(p);
    }

    // 계정 잠금 방지: 자격 증명은 (포트, 서비스 경로, 미디어 경로) 조합 하나에만, 그것도 존재가 확인된 경로에만 보낸다.
    // 자격 증명을 실은 요청이 명확한 성공이 아니면 (Fault 종류, HTTP 거절, 타임아웃, 비 SOAP 응답 모두) 로그인 실패로 보고 즉시 끝낸다.
    const auth = { username, password };
    for (const mediaPath of mediaPaths) {
        // 자격 증명 없는 GetProfiles 로 경로 존재만 확인한다. SOAP Envelope 이면 (NotAuthorized Fault 여도) 존재하는 경로다.
        // 자격 증명 없는 요청을 경로와 관계없이 HTTP 401 로 거절하는 카메라(실기 FX327)가 있어, 401 은 카메라가
        // Capabilities 로 직접 알려 준 미디어 경로일 때만 존재하는 경로로 본다.
        const probe = await soapRequest({ host, port, path: mediaPath, body: '<trt:GetProfiles/>', timeoutMs });
        const exists = probe.ok && (isEnvelope(probe.text) || (probe.status === 401 && mediaPath === capsMediaPath));
        if (!exists) continue;

        const pr = await soapRequest({ host, port, path: mediaPath, body: '<trt:GetProfiles/>', auth, offsetMs, timeoutMs });
        if (!pr.ok || !isEnvelope(pr.text) || isFault(pr.text)) return { status: 'auth_failed' };
        const profiles = parseProfiles(pr.text);
        if (profiles.length === 0) return { status: 'auth_failed' };

        const uris = [];
        for (const profile of profiles.slice(0, 4)) {
            const body = '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
                + '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
                + `<trt:ProfileToken>${xmlEscape(profile.token)}</trt:ProfileToken></trt:GetStreamUri>`;
            const ur = await soapRequest({ host, port, path: mediaPath, body, auth, offsetMs, timeoutMs });
            const uri = ur.ok && isEnvelope(ur.text) && !isFault(ur.text) ? parseUri(ur.text) : null;
            if (!uri) {
                // 이미 성공한 응답이 있으면 자격 증명은 맞다는 뜻이므로 지금까지의 결과를 돌려주고, 아니면 로그인 실패로 끝낸다
                return uris.length ? { status: 'ok', uris } : { status: 'auth_failed' };
            }
            uris.push({ token: profile.token, name: profile.name, uri });
        }
        return { status: 'ok', uris };
    }
    return { status: 'unsupported' };
}

async function getStreamUris({ host, username, password, ports, servicePaths, timeoutMs = 3000 }) {
    if (!username) return { status: 'unsupported' };   // 계정 없이는 자격 증명 요청을 보내지 않는다
    for (const port of ports) {
        if (!(await tcpOpen(host, port, 500))) continue;
        for (const servicePath of servicePaths) {
            const result = await tryEndpoint({ host, port, servicePath, username, password, timeoutMs });
            if (result.status !== 'unsupported') return result;
        }
    }
    return { status: 'unsupported' };
}

module.exports = { getStreamUris, parseUtcOffset, parseProfiles, parseUri };
