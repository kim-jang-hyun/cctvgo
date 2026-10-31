'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findStream, BOGUS_PATH } = require('../finder/find-stream');
const { AuthBudget } = require('../finder/guard');
const { createMockRtsp } = require('./helpers/mock-rtsp');
const { createMockOnvif } = require('./helpers/mock-onvif');

const HOST = '127.0.0.1';
const paths = list => list.map(p => ({ path: p, vendors: [] }));
const settingsFor = (list, onvifPorts = []) => ({ paths: paths(list), onvifPorts, onvifServicePaths: ['/onvif/device_service'] });
// 기본 인증 실패 예산. 예산을 소진시키는 테스트는 이 값에 맞춰 경로 후보 수를 만든다
const MAX = new AuthBudget().max;
// 성향 감지 1회 + 앞의 MAX-1 개로 예산이 소진되고, 마지막 후보(LAST)는 시도하지 않는다
const BUDGET_PATHS = Array.from({ length: MAX }, (_, i) => `/p${i + 1}`);
const LAST = BUDGET_PATHS[MAX - 1];

function run(cam, extra = {}) {
    return findStream({
        host: HOST,
        username: 'admin',
        password: 'pw',
        budget: new AuthBudget(),
        settings: settingsFor(['/a', '/b', '/c']),
        rtspPorts: [cam.port],
        rtspTimeoutMs: 1000,
        onvifTimeoutMs: 1000,
        ...extra,
    });
}

test('잘못된 경로에 404를 주는 카메라: 후보를 끝까지 시도해 찾고 인증 실패는 0회', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/b`);
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
        assert.ok(cam.state.requests.some(q => q.path === BOGUS_PATH), '성향 감지 요청을 보냈다');
    } finally { await cam.close(); }
});

test('비밀번호가 틀리면 인증 실패는 예산(MAX회)에서 멈춘다', async () => {
    const cam = await createMockRtsp({ validPaths: [LAST] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { password: 'wrong', budget, settings: settingsFor(BUDGET_PATHS) });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, MAX);
        assert.equal(budget.isExhausted(HOST), true);
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라: 예산(MAX회) 안에서만 시도한다', async () => {
    const cam = await createMockRtsp({ validPaths: [LAST], unknownPathStatus: 401 });
    try {
        const r = await run(cam, { settings: settingsFor(BUDGET_PATHS) });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.ambiguous, true);
        assert.equal(cam.state.failedAuth, MAX);
        assert.ok(!cam.state.requests.some(q => q.path === LAST && q.authed), '마지막 후보는 시도하지 않는다');
    } finally { await cam.close(); }
});

test('경로가 틀려도 401을 주는 카메라라도 첫 후보가 맞으면 찾는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'], unknownPathStatus: 401 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/a`);
        assert.equal(budget.failures(HOST), 0, '성공하면 예산을 초기화한다');
    } finally { await cam.close(); }
});

test('어떤 경로에도 200을 주는 카메라: 확인용 경로가 아니라 첫 경로 후보를 돌려준다', async () => {
    const cam = await createMockRtsp({ validPaths: [], unknownPathStatus: 200 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/a`);
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('DESCRIBE 는 아무 경로나 200이고 SETUP 에서 거절하는 카메라(실기 HIipCamera): SETUP 까지 되는 경로를 찾는다', async () => {
    const cam = await createMockRtsp({ connectionNonce: true, validPaths: ['/c'], unknownPathStatus: 200, unknownSetupStatus: 400 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/c`);
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('직접 입력 경로가 SETUP 에서 거절되면 path_not_found 이고 예산은 쓰지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/c'], unknownPathStatus: 200, unknownSetupStatus: 400 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget, path: '/x' });
        assert.equal(r.status, 'path_not_found');
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('nonce 를 연결마다 새로 주고 없는 경로에 401을 주는 카메라(실기 FX327): 첫 후보를 찾는다', async () => {
    const cam = await createMockRtsp({ connectionNonce: true, validPaths: ['/a'], unknownPathStatus: 401 });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/a`);
        assert.equal(cam.state.failedAuth, 1, '로그인 실패로 보이는 것은 성향 감지 1회뿐');
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('예산이 소진된 카메라에는 어떤 요청도 보내지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        for (let i = 0; i < MAX; i++) budget.recordFailure(HOST);
        const r = await run(cam, { budget });
        assert.equal(r.status, 'auth_locked');
        assert.ok(r.retryAfterSec > 0);
        assert.equal(cam.state.requests.length, 0);
    } finally { await cam.close(); }
});

test('인증이 필요 없는 카메라는 계정 없이 찾는다', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/c'] });
    try {
        const r = await run(cam, { username: '', password: '' });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://${HOST}:${cam.port}/c`);
    } finally { await cam.close(); }
});

test('계정 없이 인증이 필요한 카메라는 auth_failed (요청 예산 소모 없음)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { username: '', password: '', budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(budget.failures(HOST), 0);
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('직접 입력 경로: 맞으면 found(manual), 틀리면 path_not_found', async () => {
    const cam = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const ok = await run(cam, { path: '/b', port: cam.port });
        assert.equal(ok.status, 'found');
        assert.equal(ok.candidates[0].source, 'manual');
        const bad = await run(cam, { path: '/zzz', port: cam.port });
        assert.equal(bad.status, 'path_not_found');
    } finally { await cam.close(); }
});

test('열린 RTSP 포트가 없으면 unreachable', async () => {
    const cam = await createMockRtsp({ validPaths: ['/a'] });
    const port = cam.port;
    await cam.close();
    const r = await run({ port }, {});
    assert.equal(r.status, 'unreachable');
});

test('ONVIF: 주소를 받아 재검증하고 성향 감지 없이 찾는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/onvif/profile1', '/onvif/profile2'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.deepEqual(r.candidates.map(c => c.source), ['onvif', 'onvif']);
        assert.deepEqual(r.candidates.map(c => c.label), ['main', 'sub']);
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/onvif/profile1`);
        assert.ok(!rtsp.state.requests.some(q => q.path === BOGUS_PATH));
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF가 알려 준 주소가 실제로 접속되지 않으면 채택하지 않고 경로 후보로 폴백한다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });   // ONVIF 가 알려 주는 /onvif/profile* 는 없음
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].source, 'path');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/b`);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('ONVIF 로그인 실패: RTSP 로 더 시도하지 않고 멈춰 실패 1회만 쓴다 (비밀번호를 고쳐 한 번 더 시도할 수 있게)', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        const r = await run(rtsp, { password: 'wrong', budget, settings: settingsFor(BUDGET_PATHS, [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.onvifOnly, true);
        assert.equal(r.remaining, MAX - 1);
        assert.equal(budget.failures(HOST), 1);
        assert.equal(rtsp.state.requests.filter(q => q.authed).length, 0, 'RTSP 에는 자격 증명을 보내지 않음');
        assert.equal(onvif.state.failedAuth + rtsp.state.failedAuth, 1);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('같은 비밀번호로 다시 시도(skipOnvif): ONVIF 는 건너뛰고 RTSP 로 찾는다 (ONVIF 계정이 따로 있는 카메라)', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port, users: { onvifuser: 'other' } });
    try {
        const budget = new AuthBudget();
        const first = await run(rtsp, { budget, settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(first.status, 'auth_failed');
        assert.equal(first.onvifOnly, true);
        const credentialedBefore = onvif.state.credentialed;
        const second = await run(rtsp, { budget, skipOnvif: true, settings: settingsFor(['/a', '/b'], [onvif.port]) });
        assert.equal(second.status, 'found');
        assert.equal(second.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/b`);
        assert.equal(onvif.state.credentialed, credentialedBefore, '두 번째에는 ONVIF 에 자격 증명을 보내지 않음');
        assert.equal(budget.failures(HOST), 0, '성공하면 예산이 초기화된다');
    } finally { await rtsp.close(); await onvif.close(); }
});

test('같은 비밀번호로 다시 시도했는데 RTSP 도 틀리면 합쳐서 예산(2회)을 넘지 않는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        await run(rtsp, { password: 'wrong', budget, settings: settingsFor(BUDGET_PATHS, [onvif.port]) });
        const r = await run(rtsp, { password: 'wrong', budget, skipOnvif: true, settings: settingsFor(BUDGET_PATHS, [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.ok(onvif.state.failedAuth + rtsp.state.failedAuth <= MAX, `${onvif.state.failedAuth}+${rtsp.state.failedAuth}`);
        assert.equal(budget.isExhausted(HOST), true);
        assert.equal(r.remaining, 0);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('진단 정보에는 호스트/서버 헤더/시도 목록이 있고 비밀번호는 없다', async () => {
    const cam = await createMockRtsp({ users: { admin: 'S3cr3t!x' }, validPaths: ['/nothing'] });
    try {
        const r = await run(cam, { password: 'S3cr3t!x', vendorHint: 'Acme Cam' });
        assert.equal(r.status, 'path_not_found');
        assert.match(r.diagnostics, /카메라 IP: 127\.0\.0\.1/);
        assert.match(r.diagnostics, /Acme Cam/);
        assert.match(r.diagnostics, /MockCam\/1\.0/);
        assert.match(r.diagnostics, /realm/i);
        assert.match(r.diagnostics, /\/a → 404/);
        assert.ok(!r.diagnostics.includes('S3cr3t'));
        assert.ok(!JSON.stringify(r.tried).includes('S3cr3t'));
    } finally { await cam.close(); }
});

test('비표준 문구로 거절하는 ONVIF: 로그인 실패로 보고 멈춘다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/b'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port, canonicalFault: false, faultText: 'Authentication failed for user' });
    try {
        const budget = new AuthBudget();
        const r = await run(rtsp, { password: 'wrong', budget, settings: settingsFor(['/a', '/b', '/c'], [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.ok(onvif.state.failedAuth + rtsp.state.failedAuth <= MAX, `${onvif.state.failedAuth}+${rtsp.state.failedAuth}`);
        assert.equal(onvif.state.credentialed, 1);
    } finally { await rtsp.close(); await onvif.close(); }
});

test('아이디가 없으면 ONVIF 를 시도하지 않고 예산도 쓰지 않는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/a'] });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        const r = await run(rtsp, { username: '', password: '', budget, settings: settingsFor(['/a'], [onvif.port]) });
        assert.equal(r.status, 'auth_failed');
        assert.equal(budget.failures(HOST), 0);
        assert.equal(onvif.state.credentialed, 0);
        assert.equal(onvif.state.failedAuth, 0);
        assert.equal(onvif.state.requests.length, 0);
    } finally { await rtsp.close(); await onvif.close(); }
});

for (const code of [500, 403]) {
    test(`없는 경로에 ${code}를 주는 카메라: 후보의 401을 단정적인 비밀번호 오류(ambiguous:false)로 확정하지 않는다`, async () => {
        // 성향 감지가 404 가 아니므로 계정이 맞다는 증거가 아니다(strict=false). 자격 증명을 실은 ${code} 도 예산 1회로 센다.
        // 앞 후보들의 401 로 예산이 소진되면 ambiguous 로 멈추고, 그 뒤 마지막 후보에는 자격 증명을 보내지 않는다.
        const pathOverrides = Object.fromEntries(BUDGET_PATHS.slice(0, MAX - 1).map(p => [p, 401]));
        const cam = await createMockRtsp({ validPaths: [LAST], unknownPathStatus: code, pathOverrides });
        try {
            const budget = new AuthBudget();
            const r = await run(cam, { budget, settings: settingsFor(BUDGET_PATHS) });
            assert.equal(r.status, 'auth_failed');
            assert.equal(r.ambiguous, true);
            assert.equal(budget.isExhausted(HOST), true);
            assert.ok(cam.state.failedAuth <= MAX);
            assert.ok(!cam.state.requests.some(q => q.path === LAST && q.authed));
        } finally { await cam.close(); }
    });
}

test('자격 증명을 보낸 뒤 연결이 끊기거나 응답을 해석할 수 없어도 예산을 소모한다', async () => {
    for (const opts of [{ dropAuthed: true }, { garbleAuthed: true }]) {
        const cam = await createMockRtsp({ validPaths: ['/a'], ...opts });
        try {
            const budget = new AuthBudget();
            const r = await run(cam, { budget });
            const authed = cam.state.requests.filter(q => q.authed).length;
            assert.ok(authed <= MAX, `${JSON.stringify(opts)} authed=${authed}`);
            assert.equal(budget.failures(HOST), authed, JSON.stringify(opts));
            assert.notEqual(r.status, 'found');
        } finally { await cam.close(); }
    }
});

test('ONVIF 재검증 중 카메라가 자격 증명 DESCRIBE 에 응답하지 않으면 다음 프로파일을 시도하지 않는다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/onvif/profile1'], dropAuthed: true });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const budget = new AuthBudget();
        await run(rtsp, { budget, settings: settingsFor(['/a'], [onvif.port]) });
        assert.ok(rtsp.state.requests.filter(q => q.authed).length <= 2);
        assert.ok(budget.failures(HOST) <= 2);
        assert.ok(!rtsp.state.requests.some(q => q.path === '/onvif/profile2' && q.authed), '두 번째 프로파일에는 자격 증명을 보내지 않는다');
    } finally { await rtsp.close(); await onvif.close(); }
});

test('지원하지 않는 로그인 방식(SHA-256 Digest): 즉시 끝내고 예산도 쓰지 않는다', async () => {
    const cam = await createMockRtsp({ algorithms: ['SHA-256'], validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.authUnsupported, true);
        assert.equal(r.ambiguous, true);
        assert.equal(budget.failures(HOST), 0);
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(cam.state.requests.length, 1, '성향 감지 요청 1건 후 중단');
        assert.ok(cam.state.requests.every(q => !q.authed));
    } finally { await cam.close(); }
});

test('지원하지 않는 로그인 방식: 직접 입력 경로에서도 즉시 끝낸다', async () => {
    const cam = await createMockRtsp({ algorithms: ['SHA-256'], validPaths: ['/b'] });
    try {
        const budget = new AuthBudget();
        const r = await run(cam, { budget, path: '/b', port: cam.port });
        assert.equal(r.authUnsupported, true);
        assert.equal(budget.failures(HOST), 0);
        assert.ok(cam.state.requests.every(q => !q.authed));
    } finally { await cam.close(); }
});

test('SHA-256 과 MD5 챌린지가 함께 오면 MD5 로 찾는다', async () => {
    const cam = await createMockRtsp({ algorithms: ['SHA-256', 'MD5'], validPaths: ['/b'] });
    try {
        const r = await run(cam);
        assert.equal(r.status, 'found');
        assert.equal(cam.state.failedAuth, 0);
    } finally { await cam.close(); }
});

test('예산이 소진된 auth_failed 에는 retryAfterSec 가 있고, 소진 전에는 없다', async () => {
    const cam = await createMockRtsp({ validPaths: [LAST] });
    try {
        const r = await run(cam, { password: 'wrong', settings: settingsFor(BUDGET_PATHS) });
        assert.equal(r.status, 'auth_failed');
        assert.ok(r.retryAfterSec > 0);
    } finally { await cam.close(); }
    const cam2 = await createMockRtsp({ validPaths: ['/b'] });
    try {
        const r = await run(cam2, { username: '', password: '' });
        assert.equal(r.status, 'auth_failed');
        assert.equal(r.retryAfterSec, undefined);
    } finally { await cam2.close(); }
});

test('RTSP 가 꺼진 카메라(모든 요청에 405): 몇 번만 확인하고 rtsp_disabled 로 끝낸다', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: [], unknownPathStatus: 405 });
    try {
        const many = Array.from({ length: 30 }, (_, i) => `/p${i}`);
        const r = await run(cam, { settings: settingsFor(many) });
        assert.equal(r.status, 'rtsp_disabled');
        assert.ok(cam.state.requests.length <= 6, `요청 ${cam.state.requests.length}회`);
    } finally { await cam.close(); }
});

test('없는 경로에만 405를 주는 카메라: 실제 경로는 계속 찾는다', async () => {
    const cam = await createMockRtsp({ requireAuth: false, validPaths: ['/c'], unknownPathStatus: 405 });
    try {
        const r = await run(cam);
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${cam.port}/c`);
    } finally { await cam.close(); }
});

// --- 코덱 확인과 서브 스트림 (H.265 카메라를 PC 브라우저에서도 보기 위해) ---
const runPath = (cam, list, extra = {}) => run(cam, { settings: settingsFor(list), ...extra });

test('H.264 메인: 코덱을 붙이고 서브는 찾지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/onvif1', '/onvif2'] });
    try {
        const r = await runPath(cam, ['/onvif1']);
        assert.equal(r.candidates[0].codec, 'H264');
        assert.equal(r.candidates[0].subUrl, undefined);
        assert.ok(!cam.state.requests.some(q => q.path === '/onvif2'));
    } finally { await cam.close(); }
});

test('H.265 메인: 대응하는 서브 경로를 한 번 확인해 함께 돌려준다 (서브도 H.265)', async () => {
    const cam = await createMockRtsp({ validPaths: ['/onvif1', '/onvif2'], codecs: { '/onvif1': 'H265', '/onvif2': 'H265' } });
    try {
        const budget = new AuthBudget();
        const r = await runPath(cam, ['/onvif1'], { budget });
        const c = r.candidates[0];
        assert.equal(c.url, `rtsp://admin:pw@${HOST}:${cam.port}/onvif1`);
        assert.equal(c.codec, 'H265');
        assert.equal(c.subUrl, `rtsp://admin:pw@${HOST}:${cam.port}/onvif2`);
        assert.equal(c.subCodec, 'H265');
        assert.equal(cam.state.failedAuth, 0);
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('H.265 메인 + H.264 서브', async () => {
    const cam = await createMockRtsp({ validPaths: ['/Streaming/Channels/101', '/Streaming/Channels/102'], codecs: { '/Streaming/Channels/101': 'H265' } });
    try {
        const c = (await runPath(cam, ['/Streaming/Channels/101'])).candidates[0];
        assert.equal(c.subUrl, `rtsp://admin:pw@${HOST}:${cam.port}/Streaming/Channels/102`);
        assert.equal(c.subCodec, 'H264');
    } finally { await cam.close(); }
});

test('서브 경로가 없으면(404) 서브 없이 찾고 예산은 쓰지 않는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/onvif1'], codecs: { '/onvif1': 'H265' } });
    try {
        const budget = new AuthBudget();
        const r = await runPath(cam, ['/onvif1'], { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].subUrl, undefined);
        assert.equal(budget.failures(HOST), 0);
    } finally { await cam.close(); }
});

test('서브 확인이 401 이면 예산에 1회 기록하고 메인은 그대로 찾는다', async () => {
    const cam = await createMockRtsp({ validPaths: ['/onvif1'], codecs: { '/onvif1': 'H265' }, pathOverrides: { '/onvif2': 401 } });
    try {
        const budget = new AuthBudget();
        const r = await runPath(cam, ['/onvif1'], { budget });
        assert.equal(r.status, 'found');
        assert.equal(r.candidates[0].subUrl, undefined);
        assert.equal(budget.failures(HOST), 1);
    } finally { await cam.close(); }
});

test('ONVIF: 순서는 그대로 두고 H.265 후보에 다른 프로파일(H.264 우선)을 서브로 붙인다', async () => {
    const rtsp = await createMockRtsp({ validPaths: ['/onvif/profile1', '/onvif/profile2'], codecs: { '/onvif/profile1': 'H265' } });
    const onvif = await createMockOnvif({ rtspPort: rtsp.port });
    try {
        const r = await run(rtsp, { settings: settingsFor(['/a'], [onvif.port]) });
        assert.equal(r.candidates[0].url, `rtsp://admin:pw@${HOST}:${rtsp.port}/onvif/profile1`);
        assert.equal(r.candidates[0].codec, 'H265');
        assert.equal(r.candidates[0].subUrl, `rtsp://admin:pw@${HOST}:${rtsp.port}/onvif/profile2`);
        assert.equal(r.candidates[0].subCodec, 'H264');
        assert.equal(r.candidates[1].codec, 'H264');
        assert.equal(r.candidates[1].subUrl, undefined);
    } finally { await rtsp.close(); await onvif.close(); }
});
