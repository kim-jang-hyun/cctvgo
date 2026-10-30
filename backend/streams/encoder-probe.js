'use strict';
const { execFile } = require('child_process');

/**
 * H.265 카메라를 PC 브라우저(H.265 WebRTC 미지원)용 H.264 로 바꿀 변환기 고르기.
 * 고객 PC 마다 그래픽 장치가 달라서 고정하지 않고, 시작할 때 차례로 시험해 실제로 되는 첫 번째를 쓴다.
 * 하드웨어(Intel/NVIDIA/AMD)는 실시간, Windows 내장 소프트웨어(h264_mf)는 1~2초 늦다 (2026-10-30 시험).
 * libx264(GPL)는 쓰지 않는다 (번들 FFmpeg 에 없음).
 */

const ENCODERS = ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf'];
const ENCODER_OPTS = {
    h264_qsv: ['-look_ahead', '0'],
    h264_mf: ['-hw_encoding', '0', '-rate_control', 'cbr'],
};
// go2rtc 를 켜기 전에 시험하므로 영상이 늦게 뜨지 않게 짧게 둔다 (보통 1~2초면 성공 또는 실패한다)
const PROBE_TIMEOUT_MS = 10000;

/** 시험할 변환기 목록. CCTVGO_ENCODERS(쉼표 구분)로 바꿀 수 있다 (시험·문제 해결용). 아는 이름만 쓴다 */
function encoderList(env) {
    const list = String(env || '').split(',').map(s => s.trim()).filter(s => ENCODERS.includes(s));
    return list.length ? list : ENCODERS;
}

function runFfmpeg(cmd, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, error => {
            resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 });
        });
    });
}

async function probeEncoders({ ffmpegPath, run = runFfmpeg, encoders = ENCODERS }) {
    for (const enc of encoders) {
        const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10', '-t', '1',
            '-c:v', enc, ...(ENCODER_OPTS[enc] || []), '-f', 'null', '-'];
        try {
            const r = await run(ffmpegPath, args, { timeoutMs: PROBE_TIMEOUT_MS });
            if (r.code === 0) return enc;
        } catch (e) { /* 다음 변환기 */ }
    }
    return null;
}

/** go2rtc 설정의 h264 템플릿: 고른 변환기와 옵션. go2rtc 가 #video=h264 변환에 이 값을 쓴다 */
function encoderTemplate(encoder) {
    return ['-c:v', encoder, ...(ENCODER_OPTS[encoder] || []), '-b:v', '4M', '-g', '20', '-bf', '0'].join(' ');
}

/**
 * 변환본 소스. go2rtc 는 보안상 exec: 소스를 API 로 받지 않으므로(insecure producer) ffmpeg: 소스를 쓴다.
 * 변환은 go2rtc 가 위 템플릿으로 FFmpeg 를 실행하고, 결과를 자기 내부 RTSP(127.0.0.1)로 받는다
 */
function transcodeSource(url) {
    return `ffmpeg:${url}#video=h264`;
}

module.exports = { ENCODERS, encoderList, probeEncoders, encoderTemplate, transcodeSource };
