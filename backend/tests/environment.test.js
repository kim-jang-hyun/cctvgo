'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyIp, checkEnvironment, firewallRuleName } = require('../diagnostics/environment');

test('classifyIp: 공인/사설/통신사 공유(CGNAT) 구분', () => {
    assert.equal(classifyIp('14.4.84.110'), 'public');
    assert.equal(classifyIp('100.64.0.1'), 'cgnat');
    assert.equal(classifyIp('100.127.255.254'), 'cgnat');
    assert.equal(classifyIp('100.128.0.1'), 'public');
    assert.equal(classifyIp('192.168.0.1'), 'private');
    assert.equal(classifyIp('10.1.2.3'), 'private');
    assert.equal(classifyIp('172.16.0.1'), 'private');
    assert.equal(classifyIp('172.32.0.1'), 'public');
    assert.equal(classifyIp(''), 'unknown');
    assert.equal(classifyIp(null), 'unknown');
});

test('firewallRuleName: 설치 폴더마다 다르고 대소문자는 무시한다', () => {
    const a = firewallRuleName('C:\\cctvgo\\package');
    assert.match(a, /^CCTVGO go2rtc [0-9a-f]{8}$/);
    assert.equal(firewallRuleName('c:\\CCTVGO\\Package'), a);
    assert.notEqual(firewallRuleName('C:\\cctvgo'), a);
});

test('checkEnvironment: 방화벽/네트워크 프로필/바깥 주소/UPnP 결과를 모은다 (바깥 주소는 마스킹)', async () => {
    const commands = [];
    const run = async (cmd, args) => {
        commands.push([cmd, ...args].join(' '));
        if (cmd === 'netsh') return { code: 0, stdout: 'Rule Name: CCTVGO go2rtc abcd\nEnabled: Yes' };
        if (/NetConnectionProfile/.test(args.join(' '))) return { code: 0, stdout: 'Public\n' };
        if (/NetRoute/.test(args.join(' '))) return { code: 0, stdout: '192.168.219.1\n' };
        return { code: 1, stdout: '' };
    };
    const r = await checkEnvironment({
        installDir: 'C:\\cctvgo\\package', run,
        stun: async () => ({ ip: '14.4.84.110', port: 5000 }),
        ssdp: async () => false,
    });
    assert.equal(r.firewallRule, 'present');
    assert.equal(r.networkProfile, 'Public');
    assert.equal(r.gateway, '192.168.219.1');
    assert.equal(r.publicIp, '14.4.x.x');
    assert.equal(r.publicIpClass, 'public');
    assert.equal(r.upnp, 'no-response');
    assert.ok(commands.some(c => c.includes(firewallRuleName('C:\\cctvgo\\package'))));
});

test('checkEnvironment: 규칙이 없고 STUN 실패, UPnP 응답이 있는 경우', async () => {
    const run = async cmd => (cmd === 'netsh' ? { code: 1, stdout: 'No rules match the specified criteria.' } : { code: 0, stdout: '' });
    const r = await checkEnvironment({ installDir: 'C:\\x', run, stun: async () => null, ssdp: async () => true });
    assert.equal(r.firewallRule, 'missing');
    assert.equal(r.publicIp, null);
    assert.equal(r.publicIpClass, 'unknown');
    assert.equal(r.upnp, 'responded');
});

test('checkEnvironment: 점검 중 예외가 나도 나머지는 채운다', async () => {
    const run = async () => { throw new Error('powershell 없음'); };
    const r = await checkEnvironment({ installDir: 'C:\\x', run, stun: async () => { throw new Error('x'); }, ssdp: async () => false });
    assert.equal(r.firewallRule, 'unknown');
    assert.equal(r.networkProfile, null);
    assert.equal(r.publicIpClass, 'unknown');
    assert.equal(r.upnp, 'no-response');
});
