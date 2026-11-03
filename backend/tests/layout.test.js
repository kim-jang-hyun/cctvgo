'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cameraKeys, gridSlots, resolveLayout, moveSlot, layoutVersion, loadLayout, saveLayout } = require('../finder/layout');

const A = 'rtsp://u:p@192.168.0.1:554/a';
const B = 'rtsp://u:p@192.168.0.2:554/b';
const C = 'rtsp://u:p@192.168.0.3:554/c';
const D = 'rtsp://u:p@192.168.0.4:554/d';
const E = 'rtsp://u:p@192.168.0.5:554/e';

test('칸 수: 2줄, 최소 2열, 열 수는 카메라 수의 절반 올림', () => {
    assert.equal(gridSlots(0), 4);
    assert.equal(gridSlots(4), 4);
    assert.equal(gridSlots(5), 6);
    assert.equal(gridSlots(7), 8);
});

test('카메라 키에는 비밀번호가 없고, 비밀번호가 바뀌어도 같다', () => {
    const [k] = cameraKeys([A]);
    assert.equal(k, '192.168.0.1:554/a');
    assert.deepEqual(cameraKeys(['rtsp://x:y@192.168.0.1:554/a']), [k]);
});

test('같은 주소가 두 줄이면 키가 겹치지 않게 번호를 붙인다', () => {
    const keys = cameraKeys([A, A]);
    assert.notEqual(keys[0], keys[1]);
});

test('저장된 배치가 없으면 등록 순서대로 앞에서부터 채운다', () => {
    assert.deepEqual(resolveLayout(null, cameraKeys([A, B, C])), [...cameraKeys([A, B, C]), null]);
});

test('저장된 자리를 지키고, 새 카메라는 첫 빈 칸에 넣는다', () => {
    const [a, b, c] = cameraKeys([A, B, C]);
    // a 는 4번 칸에 저장돼 있고 b, c 는 새로 등록됨 → 등록 순서대로 앞쪽 빈 칸에
    assert.deepEqual(resolveLayout({ columns: 2, slots: [null, null, null, a] }, [a, b, c]), [b, c, null, a]);
});

test('지운 카메라 칸은 비고, 다른 카메라는 움직이지 않는다', () => {
    const [a, b, c] = cameraKeys([A, B, C]);
    assert.deepEqual(resolveLayout({ columns: 2, slots: [a, b, c, null] }, [a, c]), [a, null, c, null]);
});

test('칸 수가 줄면 없어지는 칸의 카메라는 앞쪽 첫 빈 칸으로 간다', () => {
    const [a, c, e] = cameraKeys([A, C, E]);
    const [b, d] = cameraKeys([B, D]);
    // 5대 2x3 에서 E 를 6번 칸에 두었다가 B, D 를 지움 → 3대 2x2
    // [A][B][ ]      [A][E]
    // [C][D][E]  →   [C][ ]
    const saved = { columns: 3, slots: [a, b, null, c, d, e] };
    assert.deepEqual(resolveLayout(saved, [a, c, e]), [a, e, c, null]);
});

test('칸 수가 늘어도 줄/열 위치를 지킨다', () => {
    const [a, b, c, d, e] = cameraKeys([A, B, C, D, E]);
    // 2x2 [A][B] / [C][D] 에서 E 추가 → 2x3, 아래 줄 C 는 아래 줄 그대로
    assert.deepEqual(resolveLayout({ columns: 2, slots: [a, b, c, d] }, [a, b, c, d, e]), [a, b, e, c, d, null]);
});

test('빈 칸으로 옮기면 이동, 영상이 있는 칸으로 옮기면 서로 바뀐다', () => {
    const [a, b, c] = cameraKeys([A, B, C]);
    assert.deepEqual(moveSlot([a, b, c, null], 0, 3), [null, b, c, a]);
    assert.deepEqual(moveSlot([a, b, c, null], 0, 2), [c, b, a, null]);
});

test('잘못된 칸 번호나 빈 칸에서 옮기기는 거절한다', () => {
    const [a] = cameraKeys([A]);
    assert.equal(moveSlot([a, null, null, null], 1, 2), null);
    assert.equal(moveSlot([a, null, null, null], 0, 4), null);
    assert.equal(moveSlot([a, null, null, null], -1, 0), null);
    assert.equal(moveSlot([a, null, null, null], 0, 0), null);
    assert.equal(moveSlot([a, null, null, null], 0, 1.5), null);
});

test('배치 버전은 배치가 바뀌면 달라진다', () => {
    const [a, b] = cameraKeys([A, B]);
    assert.notEqual(layoutVersion([a, b, null, null]), layoutVersion([b, a, null, null]));
    assert.equal(layoutVersion([a, b, null, null]), layoutVersion([a, b, null, null]));
});

test('배치 파일 저장/읽기, 없거나 깨진 파일은 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
    const file = path.join(dir, 'layout.json');
    assert.equal(loadLayout(file), null);
    saveLayout(file, ['x', null, null, null]);
    assert.deepEqual(loadLayout(file), { columns: 2, slots: ['x', null, null, null] });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('u:p'));
    fs.writeFileSync(file, '{깨짐');
    assert.equal(loadLayout(file), null);
    fs.writeFileSync(file, JSON.stringify({ columns: 2, slots: [1, {}] }));
    assert.equal(loadLayout(file), null);
    fs.writeFileSync(file, JSON.stringify({ slots: ['x'] }));
    assert.equal(loadLayout(file), null);
});
