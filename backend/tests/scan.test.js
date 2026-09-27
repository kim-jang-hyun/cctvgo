'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { subnetHosts, tcpOpen, scanHosts, parseDiscovery, mergeScanResults, scanNetwork } = require('../finder/scan');
const { getClosedPort } = require('./helpers/ports');

function listen() {
    return new Promise(resolve => {
        const s = net.createServer(sock => sock.end());
        s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise(r => s.close(r)) }));
    });
}

test('subnetHosts: /24는 .0/.255와 자기 자신을 뺀 253개', () => {
    const hosts = subnetHosts('192.168.0.10', '255.255.255.0');
    assert.equal(hosts.length, 253);
    assert.ok(hosts.includes('192.168.0.1') && hosts.includes('192.168.0.254'));
    assert.ok(!hosts.includes('192.168.0.10') && !hosts.includes('192.168.0.0') && !hosts.includes('192.168.0.255'));
});

test('subnetHosts: /16 이하는 자신이 속한 /24로 제한한다', () => {
    const hosts = subnetHosts('10.1.2.50', '255.255.0.0');
    assert.equal(hosts.length, 253);
    assert.ok(hosts.every(h => h.startsWith('10.1.2.')));
});

test('subnetHosts: /30 은 실제 호스트만', () => {
    assert.deepEqual(subnetHosts('192.168.0.1', '255.255.255.252'), ['192.168.0.2']);
});

test('tcpOpen: 열린 포트 true, 닫힌 포트 false', async () => {
    const srv = await listen();
    const closed = await getClosedPort();
    try {
        assert.equal(await tcpOpen('127.0.0.1', srv.port, 500), true);
        assert.equal(await tcpOpen('127.0.0.1', closed, 500), false);
    } finally { await srv.close(); }
});

test('scanHosts: 열린 포트가 있는 호스트만 돌려준다', async () => {
    const srv = await listen();
    const closed = await getClosedPort();
    try {
        const r = await scanHosts(['127.0.0.1'], [closed, srv.port], { timeoutMs: 500 });
        assert.deepEqual(r, [{ ip: '127.0.0.1', ports: [srv.port] }]);
    } finally { await srv.close(); }
});

test('parseDiscovery: ONVIF scope에서 제조사/모델을 뽑는다', () => {
    const xml = '<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Hik%20vision onvif://www.onvif.org/hardware/DS-2CD2</d:Scopes>';
    assert.deepEqual(parseDiscovery(xml), { vendor: 'Hik vision', model: 'DS-2CD2' });
    assert.deepEqual(parseDiscovery('<x/>'), { vendor: null, model: null });
});

test('mergeScanResults: 포트 스캔과 Discovery 결과를 IP 기준으로 합친다', () => {
    const merged = mergeScanResults(
        [{ ip: '192.168.0.20', ports: [554] }, { ip: '192.168.0.3', ports: [8554] }],
        [{ ip: '192.168.0.20', vendor: 'Hikvision', model: 'X' }, { ip: '192.168.0.5', vendor: 'Dahua', model: null }, { ip: '8.8.8.8', vendor: 'evil', model: null }]
    );
    assert.deepEqual(merged.map(m => m.ip), ['192.168.0.3', '192.168.0.5', '192.168.0.20']);
    const cam20 = merged.find(m => m.ip === '192.168.0.20');
    assert.deepEqual(cam20, { ip: '192.168.0.20', ports: [554], vendor: 'Hikvision', model: 'X', onvif: true });
    assert.deepEqual(merged.find(m => m.ip === '192.168.0.5').ports, []);
    assert.equal(merged.find(m => m.ip === '192.168.0.3').onvif, false);
});

test('scanNetwork: 주입한 서브넷과 discovery 로 동작한다', async () => {
    const srv = await listen();
    try {
        const r = await scanNetwork({
            subnets: [{ hosts: ['127.0.0.1'] }],
            ports: [srv.port],
            discover: async () => [{ ip: '192.168.0.5', vendor: 'X', model: 'Y' }],
        });
        assert.deepEqual(r.map(c => c.ip).sort(), ['127.0.0.1', '192.168.0.5']);
    } finally { await srv.close(); }
});
