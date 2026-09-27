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
