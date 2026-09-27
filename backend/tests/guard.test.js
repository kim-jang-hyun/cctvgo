'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIPv4, AuthBudget, createRateLimiter, createLock } = require('../finder/guard');

test('isPrivateIPv4: 사설 대역만 허용한다', () => {
    for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.0.10', '192.168.219.194']) {
        assert.equal(isPrivateIPv4(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '169.254.1.1', '192.169.0.1', '0.0.0.0']) {
        assert.equal(isPrivateIPv4(ip), false, ip);
    }
});

test('isPrivateIPv4: 호스트명/이상한 형식은 거부한다', () => {
    for (const v of ['localhost', 'camera.local', '192.168.0', '192.168.0.256', '192.168.0.1.5', '010.0.0.1', '192.168.0.01', ' 192.168.0.1', '', null, undefined, 1234]) {
        assert.equal(isPrivateIPv4(v), false, String(v));
    }
});

test('AuthBudget: 실패를 세고 예산이 소진되면 잠긴다', () => {
    let t = 1000;
    const b = new AuthBudget({ max: 2, lockMs: 60000, now: () => t });
    assert.equal(b.remaining('10.0.0.1'), 2);
    assert.equal(b.isExhausted('10.0.0.1'), false);
    assert.equal(b.recordFailure('10.0.0.1'), 1);
    assert.equal(b.isExhausted('10.0.0.1'), false);
    assert.equal(b.recordFailure('10.0.0.1'), 0);
    assert.equal(b.isExhausted('10.0.0.1'), true);
    assert.equal(b.retryAfterMs('10.0.0.1'), 60000);
    t += 20000;
    assert.equal(b.retryAfterMs('10.0.0.1'), 40000);
    assert.equal(b.remaining('10.0.0.2'), 2, 'IP별로 독립');
});

test('AuthBudget: 대기 시간이 지나면 풀리고 reset이 동작한다', () => {
    let t = 0;
    const b = new AuthBudget({ max: 2, lockMs: 1000, now: () => t });
    b.recordFailure('a'); b.recordFailure('a');
    assert.equal(b.isExhausted('a'), true);
    t = 1000;
    assert.equal(b.isExhausted('a'), false);
    assert.equal(b.remaining('a'), 2);
    b.recordFailure('a');
    b.reset('a');
    assert.equal(b.remaining('a'), 2);
});

test('createRateLimiter: 윈도우 안에서 max회까지만 허용한다', () => {
    let t = 0;
    const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.equal(rl.allow('k'), true);
    assert.equal(rl.allow('k'), true);
    assert.equal(rl.allow('k'), false);
    assert.equal(rl.allow('other'), true);
    t = 1001;
    assert.equal(rl.allow('k'), true);
});

test('createLock: 동시에 하나만 획득한다', () => {
    const lock = createLock();
    assert.equal(lock.tryAcquire(), true);
    assert.equal(lock.tryAcquire(), false);
    lock.release();
    assert.equal(lock.tryAcquire(), true);
});

// --- 인증 실패 예산 영속화 ---
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpBudgetFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-budget-')), 'finder-budget.json');

test('AuthBudget 영속화: 재시작(새 인스턴스)해도 소진 상태와 30분 창이 유지된다', () => {
    const file = tmpBudgetFile();
    let t = 1000;
    const a = new AuthBudget({ max: 2, lockMs: 60000, now: () => t, persistPath: file });
    a.recordFailure('10.0.0.1');
    a.recordFailure('10.0.0.1');
    t = 31000;
    const b = new AuthBudget({ max: 2, lockMs: 60000, now: () => t, persistPath: file });
    assert.equal(b.isExhausted('10.0.0.1'), true);
    assert.equal(b.retryAfterMs('10.0.0.1'), 30000);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved), ['10.0.0.1']);
    assert.deepEqual(Object.keys(saved['10.0.0.1']).sort(), ['count', 'last']);
});

test('AuthBudget 영속화: 만료된 항목은 복원하지 않고 저장에서도 빠진다', () => {
    const file = tmpBudgetFile();
    fs.writeFileSync(file, JSON.stringify({ '10.0.0.1': { count: 2, last: 1000 }, '10.0.0.2': { count: 1, last: 50000 } }));
    let t = 70000;
    const b = new AuthBudget({ max: 2, lockMs: 60000, now: () => t, persistPath: file });
    assert.equal(b.failures('10.0.0.1'), 0);
    assert.equal(b.failures('10.0.0.2'), 1);
    b.recordFailure('10.0.0.3');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['10.0.0.2', '10.0.0.3']);
});

test('AuthBudget 영속화: 깨진 파일/형식 오류는 조용히 빈 상태로 시작한다', () => {
    const file = tmpBudgetFile();
    fs.writeFileSync(file, '{ not json');
    assert.equal(new AuthBudget({ persistPath: file }).failures('10.0.0.1'), 0);
    fs.writeFileSync(file, JSON.stringify({ '10.0.0.1': { count: 'x', last: null }, '10.0.0.2': 5, '10.0.0.3': { count: 2, last: Date.now() } }));
    const b = new AuthBudget({ persistPath: file });
    assert.equal(b.failures('10.0.0.1'), 0);
    assert.equal(b.failures('10.0.0.2'), 0);
    assert.equal(b.failures('10.0.0.3'), 2);
    assert.equal(new AuthBudget({ persistPath: path.join(os.tmpdir(), 'cctvgo-없는-폴더', 'x.json') }).failures('a'), 0);
});

test('AuthBudget 영속화: 저장 실패(쓰기 불가 경로)에도 예외 없이 동작하고 메모리 예산은 유지된다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-budget-'));
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
        // persistPath 자체가 디렉터리이면 rename 이 실패한다
        const b = new AuthBudget({ persistPath: dir });
        assert.doesNotThrow(() => { b.recordFailure('10.0.0.1'); b.recordFailure('10.0.0.1'); b.reset('10.0.0.9'); });
        assert.equal(b.isExhausted('10.0.0.1'), true);
        const missing = new AuthBudget({ persistPath: path.join(dir, '없는폴더', 'b.json') });
        assert.doesNotThrow(() => missing.recordFailure('10.0.0.1'));
    } finally { console.error = orig; }
    assert.ok(errors.length >= 1);
    assert.ok(errors.every(e => !e.includes(dir)), '오류 로그에 파일 경로를 남기지 않는다');
});

test('AuthBudget 영속화: reset 하면 파일에서도 사라진다', () => {
    const file = tmpBudgetFile();
    const a = new AuthBudget({ persistPath: file });
    a.recordFailure('10.0.0.1');
    a.recordFailure('10.0.0.2');
    a.reset('10.0.0.1');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['10.0.0.2']);
    assert.equal(new AuthBudget({ persistPath: file }).failures('10.0.0.1'), 0);
    assert.ok(!fs.existsSync(file + '.tmp'));
});
