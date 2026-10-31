'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { datedLogName, appendLog, pruneLogs, DAY_MS } = require('../diagnostics/log-files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-logs-'));

test('datedLogName: 이름-YYYY-MM-DD.log (PC 의 현지 날짜)', () => {
    assert.equal(datedLogName('connections', new Date(2026, 0, 5, 23, 59)), 'connections-2026-01-05.log');
});

test('appendLog: 날짜가 바뀌면 새 파일에 이어 쓴다 (서비스를 재시작하지 않아도)', () => {
    const dir = tmp();
    let now = new Date(2026, 9, 31, 23, 59, 0).getTime();
    appendLog(dir, 'service', 'a', () => now);
    now += 2 * 60 * 1000;
    appendLog(dir, 'service', 'b', () => now);
    assert.equal(fs.readFileSync(path.join(dir, 'service-2026-10-31.log'), 'utf8'), 'a\n');
    assert.equal(fs.readFileSync(path.join(dir, 'service-2026-11-01.log'), 'utf8'), 'b\n');
});

test('appendLog: 폴더가 없으면 만들고, 쓰기에 실패해도 예외를 던지지 않는다', () => {
    const dir = path.join(tmp(), 'new', 'logs');
    appendLog(dir, 'x', 'line');
    assert.ok(fs.readdirSync(dir).length === 1);
    assert.doesNotThrow(() => appendLog('\0bad', 'x', 'line'));
});

function makeFile(dir, name, ageDays, bytes = 10, now = Date.now()) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 'a'));
    const t = new Date(now - ageDays * DAY_MS);
    fs.utimesSync(p, t, t);
    return p;
}

test('pruneLogs: 30일 지난 .log 를 지우고, 통계(.json)와 그 밖의 파일은 남긴다', () => {
    const dir = tmp();
    makeFile(dir, 'service-old.log', 31);
    makeFile(dir, 'service-new.log', 29);
    makeFile(dir, 'connection-stats.json', 400);
    makeFile(dir, 'firewall.declined', 400);
    const r = pruneLogs(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['connection-stats.json', 'firewall.declined', 'service-new.log']);
    assert.deepEqual(r.deleted, ['service-old.log']);
});

test('pruneLogs: 폴더가 한도(500MB)를 넘으면 가장 오래된 .log 부터 지운다 (오늘 파일은 남김)', () => {
    const dir = tmp();
    makeFile(dir, 'a.log', 3, 400);
    makeFile(dir, 'b.log', 2, 400);
    makeFile(dir, 'c.log', 0, 400);
    const r = pruneLogs(dir, { maxTotalBytes: 900 });
    assert.deepEqual(r.deleted, ['a.log']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['b.log', 'c.log']);
    const r2 = pruneLogs(dir, { maxTotalBytes: 100 });
    assert.deepEqual(r2.deleted, ['b.log']);
    assert.ok(fs.existsSync(path.join(dir, 'c.log')), '마지막(가장 최근) 파일은 지우지 않음');
});

test('pruneLogs: 폴더가 없어도 조용히 끝난다', () => {
    assert.deepEqual(pruneLogs(path.join(tmp(), 'none')).deleted, []);
});
