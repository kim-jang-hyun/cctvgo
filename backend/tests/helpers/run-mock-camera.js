'use strict';
// 수동 확인용: 이 PC에서 가짜 RTSP 카메라를 554 포트로 띄운다. (Ctrl+C 로 종료)
// 카메라 주소 찾기 화면에서 아래 출력된 IP, 아이디 admin / 비밀번호 pw 로 찾아 본다.
const os = require('os');
const { createMockRtsp } = require('./mock-rtsp');

(async () => {
    const cam = await createMockRtsp({
        host: '0.0.0.0', port: 554,
        users: { admin: 'pw' }, validPaths: ['/Streaming/Channels/101'],
    });
    const ips = Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);
    console.log(`가짜 카메라 실행 중: 포트 ${cam.port}, IP 후보: ${ips.join(', ')}`);
    console.log('아이디: admin / 비밀번호: pw / 경로: /Streaming/Channels/101');
})();
