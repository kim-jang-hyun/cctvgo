// 실행: node --test frontend/tests/stall.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStallTracker, STALL_MS } from '../src/stall.js';

test('받은 바이트가 늘고 있으면 멈춘 것이 아니다', () => {
  const t = createStallTracker(0);
  assert.equal(t.update(100, 5000), false);
  assert.equal(t.update(200, 10000), false);
  assert.equal(t.update(300, 60000), false);
});

test('받은 바이트가 STALL_MS 동안 그대로면 멈춘 것이다', () => {
  const t = createStallTracker(0);
  t.update(100, 1000);
  assert.equal(t.update(100, 1000 + STALL_MS - 1), false);
  assert.equal(t.update(100, 1000 + STALL_MS), true);
});

test('통계를 못 읽은 경우(null)는 판단에 넣지 않는다', () => {
  const t = createStallTracker(0);
  t.update(100, 1000);
  assert.equal(t.update(null, 1000 + STALL_MS * 3), false);
});

test('중간에 바이트가 늘면 기준 시각을 다시 잡는다', () => {
  const t = createStallTracker(0);
  t.update(100, 1000);
  t.update(150, 1000 + STALL_MS - 1);
  assert.equal(t.update(150, 1000 + STALL_MS + 5), false);
});
