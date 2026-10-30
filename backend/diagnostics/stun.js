'use strict';
const dgram = require('dgram');
const crypto = require('crypto');

/**
 * STUN(RFC 5389) Binding 요청으로 이 PC 의 바깥 주소(공유기가 인터넷에 보여 주는 IP:포트)를 알아낸다.
 * 진단용이다: 공인 IP 인지, 통신사 공유 IP(CGNAT)인지 기록해 외부 시청 실패 원인을 좁힌다.
 */

const MAGIC = 0x2112A442;

function parseBindingResponse(buf, txid) {
    if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
    if (buf.readUInt16BE(0) !== 0x0101 || buf.readUInt32BE(4) !== MAGIC) return null;
    if (!buf.subarray(8, 20).equals(txid)) return null;
    const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
    let off = 20;
    let mapped = null;
    while (off + 4 <= end) {
        const type = buf.readUInt16BE(off);
        const len = buf.readUInt16BE(off + 2);
        const v = off + 4;
        if (v + len > end) break;
        if ((type === 0x0020 || type === 0x0001) && len >= 8 && buf.readUInt8(v + 1) === 0x01) {
            const xor = type === 0x0020;
            const port = buf.readUInt16BE(v + 2) ^ (xor ? MAGIC >>> 16 : 0);
            const n = (buf.readUInt32BE(v + 4) ^ (xor ? MAGIC : 0)) >>> 0;
            const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
            if (xor) return { ip, port };
            mapped = { ip, port };
        }
        off = v + len + ((4 - (len % 4)) % 4);
    }
    return mapped;
}

function stunBinding({ server = 'stun.l.google.com', port = 19302, timeoutMs = 3000 } = {}) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        const txid = crypto.randomBytes(12);
        const req = Buffer.alloc(20);
        req.writeUInt16BE(0x0001, 0);
        req.writeUInt16BE(0, 2);
        req.writeUInt32BE(MAGIC, 4);
        txid.copy(req, 8);
        let done = false;
        const finish = result => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.close(); } catch (e) { /* 이미 닫힘 */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        sock.on('error', () => finish(null));
        sock.on('message', msg => {
            const r = parseBindingResponse(msg, txid);
            if (r) finish(r);
        });
        sock.send(req, port, server, err => { if (err) finish(null); });
    });
}

module.exports = { parseBindingResponse, stunBinding, MAGIC };
