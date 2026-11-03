// 실행: node --test frontend/tests/camera-down.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDownSince, isLongDown, CAMERA_DOWN_LONG_MS } from '../src/camera-down.js';

test('카메라 응답 없음이 처음 나온 시각을 기억하고, 다시 시도해도 유지한다', () => {
  let since = nextDownSince(null, 'failed', 'camera', 1000);
  assert.equal(since, 1000);
  since = nextDownSince(since, 'connecting', undefined, 6000);
  assert.equal(since, 1000);
  since = nextDownSince(since, 'failed', 'camera', 7000);
  assert.equal(since, 1000);
});

test('재생되면 기록을 지운다', () => {
  assert.equal(nextDownSince(1000, 'playing', undefined, 5000), null);
});

test('다른 이유로 실패하면 카메라 상태를 알 수 없으니 지운다', () => {
  assert.equal(nextDownSince(1000, 'failed', 'network', 5000), null);
  assert.equal(nextDownSince(1000, 'failed', 'signaling', 5000), null);
});

test('기록 없이 연결 중이면 기록 없음', () => {
  assert.equal(nextDownSince(null, 'connecting', undefined, 5000), null);
});

test('2분이 지나야 오래 끊긴 것으로 본다', () => {
  assert.equal(isLongDown(null, 10 ** 9), false);
  assert.equal(isLongDown(0, CAMERA_DOWN_LONG_MS - 1), false);
  assert.equal(isLongDown(0, CAMERA_DOWN_LONG_MS), true);
});
