'use strict';

/**
 * go2rtc 설정(YAML) 만들기. 시작할 때마다 cctv.txt 로 새로 만들므로 이 파일은 언제 지워져도 된다.
 * - 관리 API 와 내부 RTSP(변환본을 받는 곳)는 127.0.0.1 에만 연다. local_auth 가 없으면 같은 PC 요청은 비밀번호 없이 통과한다.
 * - 외부에 열리는 것은 WebRTC 포트 하나뿐이다. 바깥 주소는 무료 공용 STUN 으로만 알아낸다 (TURN 없음).
 * 값은 JSON 문자열로 감싼다 (YAML 은 JSON 문자열을 그대로 읽는다. 비밀번호의 #, ", $ 등이 깨지지 않는다).
 */

const DEFAULT_PORTS = { api: 1984, rtsp: 8554, webrtc: 8555 };
const STUN_SERVER = 'stun:stun.l.google.com:19302';

/** 카메라 번호 k 의 go2rtc 스트림 이름: 원본, 서브, PC 브라우저용 H.264 변환본 */
function streamNames(k) {
    return { main: `s${k}`, sub: `s${k}_sub`, h264: `s${k}_h264` };
}

function buildConfig({ apiPort, rtspPort, webrtcPort, username, password, streams, ffmpeg = null }) {
    const q = JSON.stringify;
    const lines = [
        'api:',
        `  listen: ${q(`127.0.0.1:${apiPort}`)}`,
        `  username: ${q(username)}`,
        `  password: ${q(password)}`,
        '  local_auth: true',
        'rtsp:',
        `  listen: ${q(`127.0.0.1:${rtspPort}`)}`,
        'webrtc:',
        `  listen: ${q(`:${webrtcPort}`)}`,
        '  candidates:',
        `    - ${q(`stun:${webrtcPort}`)}`,
        '  ice_servers:',
        `    - urls: [${q(STUN_SERVER)}]`,
    ];
    // H.265 → H.264 변환(PC 브라우저용): FFmpeg 경로와, 이 PC 에서 고른 변환기로 바꾼 h264 템플릿
    if (ffmpeg) {
        lines.push('ffmpeg:', `  bin: ${q(ffmpeg.bin)}`, `  h264: ${q(ffmpeg.h264)}`);
    }
    const entries = Object.entries(streams || {});
    if (entries.length === 0) {
        lines.push('streams: {}');
    } else {
        lines.push('streams:');
        for (const [name, src] of entries) lines.push(`  ${q(name)}: ${q(src)}`);
    }
    return lines.join('\n') + '\n';
}

module.exports = { buildConfig, streamNames, DEFAULT_PORTS, STUN_SERVER };
