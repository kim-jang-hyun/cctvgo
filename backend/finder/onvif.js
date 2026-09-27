'use strict';
const http = require('http');
const crypto = require('crypto');
const { tcpOpen } = require('./scan');

/**
 * ONVIF 유니캐스트 SOAP 로 스트림 URI를 받아온다.
 * - 인증이 필요한 요청(GetProfiles/GetStreamUri)은 WS-Security UsernameToken(PasswordDigest)를 쓴다.
 * - 카메라와 서버의 시계 오차는 GetSystemDateAndTime 으로 보정한다.
 * - NotAuthorized Fault 를 받으면 즉시 auth_failed 로 끝낸다 (재시도하지 않는다: 계정 잠금 방지).
 * - SOAP 이 아닌 응답(404, HTTP 401 등)은 unsupported 로 보고 인증 실패로 세지 않는다.
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
const isNotAuthorized = text => /NotAuthorized|not authorized/i.test(text);

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
    const caps = await soapRequest({
        host, port, path: servicePath, timeoutMs,
        body: '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
    });
    if (caps.ok && isEnvelope(caps.text)) {
        const m = /<(?:\w+:)?Media>[\s\S]*?<(?:\w+:)?XAddr>([^<]+)</.exec(caps.text);
        if (m) {
            try { mediaPaths.push(new URL(decodeXml(m[1].trim())).pathname); } catch (e) { /* 무시 */ }
        }
    }
    for (const p of ['/onvif/media_service', '/onvif/media', servicePath]) {
        if (!mediaPaths.includes(p)) mediaPaths.push(p);
    }

    const auth = { username, password };
    for (const mediaPath of mediaPaths) {
        const pr = await soapRequest({ host, port, path: mediaPath, body: '<trt:GetProfiles/>', auth, offsetMs, timeoutMs });
        if (!pr.ok || !isEnvelope(pr.text)) continue;
        if (isNotAuthorized(pr.text)) return { status: 'auth_failed' };
        const profiles = parseProfiles(pr.text);
        if (profiles.length === 0) continue;

        const uris = [];
        for (const profile of profiles.slice(0, 4)) {
            const body = '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
                + '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
                + `<trt:ProfileToken>${xmlEscape(profile.token)}</trt:ProfileToken></trt:GetStreamUri>`;
            const ur = await soapRequest({ host, port, path: mediaPath, body, auth, offsetMs, timeoutMs });
            if (ur.ok && isEnvelope(ur.text) && isNotAuthorized(ur.text)) return { status: 'auth_failed' };
            if (!ur.ok || !isEnvelope(ur.text)) continue;
            const uri = parseUri(ur.text);
            if (uri) uris.push({ token: profile.token, name: profile.name, uri });
        }
        if (uris.length) return { status: 'ok', uris };
    }
    return { status: 'unsupported' };
}

async function getStreamUris({ host, username, password, ports, servicePaths, timeoutMs = 3000 }) {
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
