'use strict';
// & 가 들어간 RTSP 주소가 StreamManager(spawnStream) -> run_single_stream.bat -> ffmpeg 까지 온전히 전달되는지 확인한다.
// 사용: node tests/helpers/amp-path-check.js [대기 ms, 기본 15000]
// 가짜 카메라(127.0.0.1:5540)가 받은 요청 경로를 보고 판정하고, 종료 코드 0=PASS, 1=FAIL.
const { createMockRtsp } = require('./mock-rtsp');

const WAIT_MS = Number(process.argv[2] || 15000);
const PLAIN = '/Streaming/Channels/101';
const AMP = '/cam/realmonitor?channel=1&subtype=0';

(async () => {
    const cam = await createMockRtsp({ requireAuth: false, port: 5540, validPaths: [PLAIN, AMP] });
    console.log(`가짜 카메라 대기 중 (포트 ${cam.port}, ${WAIT_MS / 1000}초)`);
    await new Promise(resolve => setTimeout(resolve, WAIT_MS));

    const paths = Array.from(new Set(cam.state.requests.map(r => r.path)));
    console.log('받은 요청 경로:', paths);
    const okPlain = paths.includes(PLAIN);
    const okAmp = paths.includes(AMP);
    console.log(`기존 형식(& 없음): ${okPlain ? 'PASS' : 'FAIL'}`);
    console.log(`& 포함 형식     : ${okAmp ? 'PASS' : 'FAIL'}`);
    await cam.close();
    process.exit(okPlain && okAmp ? 0 : 1);
})();
