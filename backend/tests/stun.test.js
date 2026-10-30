'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { parseBindingResponse, stunBinding, MAGIC } = require('../diagnostics/stun');

/** XOR-MAPPED-ADDRESS 하나를 담은 Binding Success Response */
function response(txid, ip, port) {
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0);
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(0, 4);
    attr.writeUInt8(0x01, 5);
    attr.writeUInt16BE(port ^ (MAGIC >>> 16), 6);
    const n = ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
    attr.writeUInt32BE((n ^ MAGIC) >>> 0, 8);
    const head = Buffer.alloc(20);
    head.writeUInt16BE(0x0101, 0);
    head.writeUInt16BE(attr.length, 2);
    head.writeUInt32BE(MAGIC, 4);
    txid.copy(head, 8);
    return Buffer.concat([head, attr]);
}

test('parseBindingResponse: XOR-MAPPED-ADDRESS 를 해석한다', () => {
    const txid = Buffer.from('0123456789ab');
    assert.deepEqual(parseBindingResponse(response(txid, '14.4.84.110', 55087), txid), { ip: '14.4.84.110', port: 55087 });
});

test('parseBindingResponse: transaction id 가 다르면 null', () => {
    assert.equal(parseBindingResponse(response(Buffer.from('0123456789ab'), '1.2.3.4', 1), Buffer.from('zzzzzzzzzzzz')), null);
});

test('stunBinding: 로컬 가짜 STUN 서버에서 바깥 주소를 받는다', async () => {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
        const txid = msg.subarray(8, 20);
        server.send(response(txid, '203.0.113.9', 40000), rinfo.port, rinfo.address);
    });
    await new Promise(r => server.bind(0, '127.0.0.1', r));
    try {
        const r = await stunBinding({ server: '127.0.0.1', port: server.address().port, timeoutMs: 2000 });
        assert.deepEqual(r, { ip: '203.0.113.9', port: 40000 });
    } finally { server.close(); }
});

test('stunBinding: 응답이 없으면 시간 제한 뒤 null', async () => {
    const silent = dgram.createSocket('udp4');
    await new Promise(r => silent.bind(0, '127.0.0.1', r));
    try {
        assert.equal(await stunBinding({ server: '127.0.0.1', port: silent.address().port, timeoutMs: 300 }), null);
    } finally { silent.close(); }
});
