'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamManager } = require('../streams/stream-manager');

/** go2rtc API 대신 호출을 기록하는 가짜. fail 에 이름을 넣으면 그 이름의 PUT 이 실패한다 */
function fakeApi() {
    const calls = [];
    const api = {
        fail: new Set(),
        gate: null,
        async putStream(name, src) {
            if (this.gate) await this.gate;
            calls.push(['put', name, src]);
            if (this.fail.has(name)) throw new Error('go2rtc 실패');
        },
        async deleteStream(name) { calls.push(['del', name]); },
    };
    return { api, calls };
}

function setup({ transcodeSource } = {}) {
    const f = fakeApi();
    const logs = [];
    const mgr = new StreamManager({ api: f.api, transcodeSource, log: m => logs.push(m), error: m => logs.push(m) });
    return { mgr, logs, ...f };
}

const [A, B, C, D] = ['rtsp://a:secret@192.168.0.1:554/x', 'rtsp://a:secret@192.168.0.2:554/y', 'rtsp://a:secret@192.168.0.3:554/z', 'rtsp://a:secret@192.168.0.4:554/w'];
const SUB_B = 'rtsp://a:secret@192.168.0.2:554/y2';
const touched = calls => [...new Set(calls.map(c => c[1]))].sort();

test('initialStreams: 1..N 번호를 배정하고 서브가 있으면 _sub 도 만든다', () => {
    const { mgr } = setup();
    assert.deepEqual(mgr.initialStreams([{ url: A, subUrl: null }, { url: B, subUrl: SUB_B }]), { s1: A, s2: B, s2_sub: SUB_B });
    assert.deepEqual(mgr.streamIds([A, B]), [1, 2]);
});

test('initialStreams: 변환원이 있으면 _h264 도 만든다', () => {
    const { mgr } = setup({ transcodeSource: url => `exec:ffmpeg -i ${url} {output}` });
    const s = mgr.initialStreams([{ url: A, subUrl: null }]);
    assert.equal(s.s1_h264, `exec:ffmpeg -i ${A} {output}`);
});

test('add: 다음 번호를 돌려주고 그 카메라 이름만 PUT 한다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: A }, { url: B }]);
    assert.equal(await mgr.add(C), 3);
    assert.deepEqual(calls, [['put', 's3', C]]);
});

test('add: 서브 주소가 있으면 _sub 도 PUT 한다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([]);
    await mgr.add(B, SUB_B);
    assert.deepEqual(calls, [['put', 's1', B], ['put', 's1_sub', SUB_B]]);
});

test('remove 뒤 add: 번호를 재사용하지 않고 다른 카메라는 건드리지 않는다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: A }, { url: B, subUrl: SUB_B }, { url: C }]);
    await mgr.remove(B);
    assert.equal(await mgr.add(D), 4);
    assert.deepEqual(touched(calls), ['s2', 's2_h264', 's2_sub', 's4']);
    assert.deepEqual(mgr.streamIds([A, C, D, B]), [1, 3, 4, null]);
});

test('restart: 같은 번호로 그 카메라의 원본/서브만 바꾼다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: A }, { url: B, subUrl: SUB_B }]);
    const B2 = 'rtsp://n:pw@192.168.0.2:554/y';
    const SUB_B2 = 'rtsp://n:pw@192.168.0.2:554/y2';
    await mgr.restart(B, B2, SUB_B2);
    assert.deepEqual(calls, [['put', 's2', B2], ['put', 's2_sub', SUB_B2]]);
    assert.deepEqual(mgr.streamIds([A, B2]), [1, 2]);
});

test('restart: 서브가 없어지면 _sub 를 지운다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: B, subUrl: SUB_B }]);
    await mgr.restart(B, B, null);
    assert.deepEqual(calls, [['put', 's1', B], ['del', 's1_sub']]);
});

test('restart: 대응표에 없던 카메라면 새 번호로 켠다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: A }]);
    await mgr.restart(B, C);
    assert.deepEqual(calls, [['put', 's2', C]]);
});

test('resync: 대응표 전체를 다시 PUT 하고, 그동안 들어온 add 는 끝난 뒤 실행된다', async () => {
    const { mgr, api, calls } = setup();
    mgr.initialStreams([{ url: A }, { url: B, subUrl: SUB_B }]);
    let open;
    api.gate = new Promise(r => { open = r; });
    const r = mgr.resync();
    const a = mgr.add(C);
    open();
    api.gate = null;
    await Promise.all([r, a]);
    assert.deepEqual(calls.map(c => c[1]), ['s1', 's2', 's2_sub', 's3']);
});

test('streamIds: 같은 주소가 여러 줄이면 앞에서부터 짝짓고, 없는 주소는 null', () => {
    const { mgr } = setup();
    mgr.initialStreams([{ url: A }, { url: A }]);
    assert.deepEqual(mgr.streamIds([A, A, A, B]), [1, 2, null, null]);
});

test('add: go2rtc 가 실패해도 대응표에는 남는다 (cctv.txt 와 어긋나지 않게)', async () => {
    const { mgr, api } = setup();
    mgr.initialStreams([]);
    api.fail.add('s1');
    await assert.rejects(mgr.add(A));
    assert.deepEqual(mgr.streamIds([A]), [1]);
});

test('variantsOf: 원본 → 서브 → 변환본 순서, 없는 것은 빠진다', () => {
    const plain = setup();
    plain.mgr.initialStreams([{ url: A }, { url: B, subUrl: SUB_B }]);
    assert.deepEqual(plain.mgr.variantsOf(1), [{ variant: 'main', name: 's1' }]);
    assert.deepEqual(plain.mgr.variantsOf(2), [{ variant: 'main', name: 's2' }, { variant: 'sub', name: 's2_sub' }]);
    assert.deepEqual(plain.mgr.variantsOf(9), []);
    const tr = setup({ transcodeSource: () => 'exec:x {output}' });
    tr.mgr.initialStreams([{ url: A }]);
    assert.deepEqual(tr.mgr.variantsOf(1).map(v => v.variant), ['main', 'h264']);
});

test('setTranscodeSource 뒤 resync: 모든 카메라에 변환본을 더한다', async () => {
    const { mgr, calls } = setup();
    mgr.initialStreams([{ url: A }]);
    mgr.setTranscodeSource(url => `exec:${url}`);
    await mgr.resync();
    assert.deepEqual(calls, [['put', 's1', A], ['put', 's1_h264', `exec:${A}`]]);
});

test('로그에 카메라 주소(비밀번호)를 남기지 않는다', async () => {
    const { mgr, logs } = setup();
    mgr.initialStreams([{ url: A }]);
    await mgr.add(B);
    await mgr.remove(A);
    assert.ok(logs.length > 0);
    assert.ok(logs.every(l => !l.includes('secret')));
});
