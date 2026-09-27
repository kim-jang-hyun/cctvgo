'use strict';
const net = require('net');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { isPrivateIPv4 } = require('./guard');

/**
 * 카메라 후보 탐색
 * - 서버 NIC의 사설 서브넷(최대 /24)을 RTSP 포트로 스캔한다.
 * - ONVIF WS-Discovery(UDP 멀티캐스트)로 제조사/모델 힌트를 보강한다 (실패해도 스캔은 계속).
 */

const RTSP_PORTS = [554, 8554, 88, 10554];

function ipToInt(ip) {
    return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

function intToIp(n) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function prefixLength(netmask) {
    return ipToInt(netmask).toString(2).split('').filter(c => c === '1').length;
}

/** address 가 속한 서브넷의 호스트 IP 목록 (prefix가 24보다 작아도 /24로 제한, 자기 자신 제외) */
function subnetHosts(address, netmask) {
    const prefix = Math.max(24, prefixLength(netmask));
    const size = Math.pow(2, 32 - prefix);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = (ipToInt(address) & mask) >>> 0;
    const hosts = [];
    for (let i = 1; i < size - 1; i++) {
        const ip = intToIp(network + i);
        if (ip !== address) hosts.push(ip);
    }
    return hosts;
}

function getLocalSubnets() {
    const result = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            const isV4 = a.family === 'IPv4' || a.family === 4;
            if (!isV4 || a.internal || !isPrivateIPv4(a.address)) continue;
            result.push({ address: a.address, netmask: a.netmask, hosts: subnetHosts(a.address, a.netmask) });
        }
    }
    return result;
}

function tcpOpen(host, port, timeoutMs = 500) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        let done = false;
        const end = ok => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => end(false));
        socket.on('connect', () => end(true));
        socket.on('error', () => end(false));
    });
}

async function scanHosts(hosts, ports, { concurrency = 64, timeoutMs = 500 } = {}) {
    const tasks = [];
    for (const h of hosts) for (const p of ports) tasks.push([h, p]);
    const open = new Map();
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const [h, p] = tasks[next++];
            if (await tcpOpen(h, p, timeoutMs)) {
                if (!open.has(h)) open.set(h, []);
                open.get(h).push(p);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return Array.from(open.entries())
        .map(([ip, openPorts]) => ({ ip, ports: openPorts.sort((a, b) => a - b) }))
        .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

function parseDiscovery(xml) {
    const scopes = (/<(?:\w+:)?Scopes[^>]*>([^<]*)</.exec(xml) || [])[1] || '';
    const pick = key => {
        const m = new RegExp('onvif://www\\.onvif\\.org/' + key + '/(\\S+)', 'i').exec(scopes);
        if (!m) return null;
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    };
    return { vendor: pick('name'), model: pick('hardware') };
}

/** ONVIF WS-Discovery Probe. 어떤 오류든 빈 배열로 끝낸다. */
function wsDiscovery({ timeoutMs = 2000 } = {}) {
    return new Promise(resolve => {
        const found = new Map();
        let socket;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            try { socket.close(); } catch (e) { /* 이미 닫힘 */ }
            resolve(Array.from(found.entries()).map(([ip, info]) => ({ ip, ...info })));
        };
        try {
            socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch (e) {
            return resolve([]);
        }
        const probe = '<?xml version="1.0" encoding="UTF-8"?>'
            + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
            + `<e:Header><w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>`
            + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
        socket.on('message', (msg, rinfo) => found.set(rinfo.address, parseDiscovery(msg.toString('utf8'))));
        socket.on('error', finish);
        socket.bind(0, () => {
            try { socket.send(probe, 3702, '239.255.255.250'); } catch (e) { finish(); }
        });
        setTimeout(finish, timeoutMs);
    });
}

function mergeScanResults(open, discovered) {
    const map = new Map();
    for (const o of open) map.set(o.ip, { ip: o.ip, ports: o.ports, vendor: null, model: null, onvif: false });
    for (const d of discovered) {
        if (!isPrivateIPv4(d.ip)) continue;
        const entry = map.get(d.ip) || { ip: d.ip, ports: [], vendor: null, model: null, onvif: false };
        entry.vendor = d.vendor || entry.vendor;
        entry.model = d.model || entry.model;
        entry.onvif = true;
        map.set(d.ip, entry);
    }
    return Array.from(map.values()).sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

async function scanNetwork({ ports = RTSP_PORTS, subnets = getLocalSubnets(), discover = wsDiscovery } = {}) {
    const hosts = subnets.flatMap(s => s.hosts);
    const [open, discovered] = await Promise.all([scanHosts(hosts, ports), discover()]);
    return mergeScanResults(open, discovered);
}

module.exports = {
    RTSP_PORTS, subnetHosts, getLocalSubnets, tcpOpen, scanHosts,
    parseDiscovery, wsDiscovery, mergeScanResults, scanNetwork,
};
