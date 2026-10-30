'use strict';
const fs = require('fs');
const path = require('path');

/**
 * RTSP 경로 후보.
 * - 앞쪽일수록 흔한 경로다. vendors 는 제조사 힌트(WS-Discovery 이름/모델)와 대소문자 무시 부분일치로 비교한다.
 * - 설치형 제품이라 출시 후 수정이 어렵다. 후보를 추가할 때는 이 목록 또는 설치 폴더의 rtsp-paths.json 을 쓴다.
 */
const RAW = [
    ['/Streaming/Channels/101', ['hikvision', 'hik', 'ezviz']],
    ['/onvif1', []],
    ['/stream1', ['tp-link', 'tapo', 'vstarcam']],
    ['/cam/realmonitor?channel=1&subtype=0', ['dahua', 'amcrest', 'imou', 'lorex']],
    ['/h264Preview_01_main', ['reolink']],
    ['/live/ch00_0', ['xiongmai', 'xm']],
    ['/live/ch0', []],
    ['/live', []],
    ['/stream', []],
    ['/h264', []],
    ['/1', []],
    ['/11', ['foscam']],
    ['/ch01', []],
    ['/Streaming/Channels/102', ['hikvision', 'hik', 'ezviz']],
    ['/Streaming/Channels/1', ['hikvision', 'hik']],
    ['/Streaming/Channels/201', ['hikvision', 'hik']],
    ['/Streaming/Unicast/channels/101', ['hikvision', 'hik']],
    ['/h264/ch1/main/av_stream', ['hikvision', 'hik']],
    ['/h264/ch1/sub/av_stream', ['hikvision', 'hik']],
    ['/cam/realmonitor?channel=1&subtype=1', ['dahua', 'amcrest', 'imou', 'lorex']],
    ['/h264Preview_01_sub', ['reolink']],
    ['/Preview_01_main', ['reolink']],
    ['/stream2', ['tp-link', 'tapo', 'vstarcam']],
    ['/onvif2', []],
    ['/onvif3', []],
    ['/profile1', []],
    ['/profile2', []],
    ['/profile1/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/profile2/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/profile5/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/onvif/profile1/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/onvif/profile2/media.smp', ['hanwha', 'samsung', 'wisenet']],
    ['/axis-media/media.amp', ['axis']],
    ['/axis-media/media.amp?videocodec=h264', ['axis']],
    ['/mpeg4/media.amp', ['axis']],
    ['/live.sdp', ['vivotek']],
    ['/live1.sdp', ['vivotek']],
    ['/live2.sdp', ['vivotek']],
    ['/videoMain', ['foscam']],
    ['/videoSub', ['foscam']],
    ['/media/video1', ['uniview', 'unv', 'sony']],
    ['/media/video2', ['uniview', 'unv', 'sony']],
    ['/unicast/c1/s0/live', ['uniview', 'unv']],
    ['/unicast/c1/s1/live', ['uniview', 'unv']],
    ['/MediaInput/h264', ['panasonic']],
    ['/MediaInput/mpeg4', ['panasonic']],
    ['/nphMpeg4/g726-640x480', ['panasonic']],
    ['/rtsp_tunnel', ['bosch']],
    ['/s0', ['ubiquiti', 'unifi']],
    ['/s1', ['ubiquiti', 'unifi']],
    ['/CH001.sdp', ['geovision']],
    ['/CH002.sdp', ['geovision']],
    ['/live/main', ['milesight']],
    ['/live/sub', ['milesight']],
    ['/live/0/MAIN', []],
    ['/live/1/SUB', []],
    ['/live/av0', []],
    ['/av0_0', []],
    ['/av1_0', []],
    ['/tcp/av0_0', []],
    ['/udp/av0_0', []],
    ['/cam1/h264', []],
    ['/cam1/mpeg4', []],
    ['/cam1/onvif-h264', []],
    ['/video1', []],
    ['/video.h264', []],
    ['/mpeg4', []],
    ['/mpeg4/1/media.amp', []],
    ['/ch0_0.h264', []],
    ['/ch0_1.h264', []],
    ['/ch1', []],
    ['/ch2', []],
    ['/0', []],
    ['/2', []],
    ['/12', []],
    ['/main', []],
    ['/sub', []],
    ['/stream0', []],
    ['/h264_stream', []],
    ['/live/ch01_0', []],
    ['/live/ch1', []],
    ['/1/h264major', []],
    ['/1/stream1', []],
    ['/ipcam/stream.sdp', []],
    ['/ipcam.sdp', []],
];

const BUILT_IN_PATHS = RAW.map(([p, vendors]) => ({ path: p, vendors }));
const BUILT_IN_ONVIF_PORTS = [80, 8080, 2020, 8000, 8899];
const BUILT_IN_ONVIF_SERVICE_PATHS = ['/onvif/device_service'];

function readExternal(baseDir) {
    const file = path.join(baseDir, 'rtsp-paths.json');
    try {
        if (!fs.existsSync(file)) return {};
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error('rtsp-paths.json 을 읽을 수 없어 내장 후보만 사용합니다:', error.message);
        return {};
    }
}

function unique(list) {
    return Array.from(new Set(list));
}

/** 내장 값과 설치 폴더의 rtsp-paths.json 을 합친 설정 (호출할 때마다 파일을 다시 읽는다) */
function loadSettings(baseDir) {
    const ext = readExternal(baseDir);
    const extPaths = (Array.isArray(ext.paths) ? ext.paths : [])
        .filter(p => typeof p === 'string' && p.startsWith('/'))
        .map(p => ({ path: p, vendors: [], external: true }));
    const extPorts = (Array.isArray(ext.onvifPorts) ? ext.onvifPorts : [])
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 65535);
    const extServicePaths = (Array.isArray(ext.onvifServicePaths) ? ext.onvifServicePaths : [])
        .filter(p => typeof p === 'string' && p.startsWith('/'));

    return {
        paths: [...extPaths, ...BUILT_IN_PATHS],
        onvifPorts: unique([...BUILT_IN_ONVIF_PORTS, ...extPorts]),
        onvifServicePaths: unique([...BUILT_IN_ONVIF_SERVICE_PATHS, ...extServicePaths]),
    };
}

/** 외부 경로가 맨 앞, 그 다음 제조사 힌트와 일치하는 경로, 나머지 순서. 중복 제거. */
function orderedPaths(settings, vendorHint = '') {
    const hint = String(vendorHint || '').toLowerCase();
    const matches = entry => hint !== '' && entry.vendors.some(v => hint.includes(v));
    // external 표시가 있으면 내장 후보와 겹쳐도 맨 앞 (rtsp-paths.json 이 출시 후 유일한 보강 수단이므로). 표시가 없는 설정은 내장에 없는 값만 외부로 본다
    const isExternal = e => e.external === true || (e.external === undefined && e.vendors.length === 0 && !BUILT_IN_PATHS.some(b => b.path === e.path));
    const external = settings.paths.filter(isExternal);
    const rest = settings.paths.filter(e => !external.includes(e));
    return unique([
        ...external.map(e => e.path),
        ...rest.filter(matches).map(e => e.path),
        ...rest.filter(e => !matches(e)).map(e => e.path),
    ]);
}

/**
 * 메인 스트림 경로에 대응하는 서브 스트림 경로 (H.265 메인 카메라에서 PC 브라우저용 대체를 찾을 때 쓴다).
 * 처음 맞는 규칙 하나만 적용한다. 해당 규칙이 없으면 null.
 */
const SUB_RULES = [
    [/^(\/Streaming\/Channels\/\d)01$/i, '$102'],
    [/subtype=0/i, 'subtype=1'],
    [/_main$/i, '_sub'],
    [/\/(ch\d+)\/main\//i, '/$1/sub/'],
    [/\/stream1$/i, '/stream2'],
    [/\/onvif1$/i, '/onvif2'],
    [/\/profile1(\/|$)/i, '/profile2$1'],
    [/\/live\/ch00_0$/i, '/live/ch00_1'],
    [/\/videoMain$/, '/videoSub'],
    [/\/media\/video1$/i, '/media/video2'],
    [/\/live1\.sdp$/i, '/live2.sdp'],
    [/\/unicast\/c(\d+)\/s0\//i, '/unicast/c$1/s1/'],
    [/^\/s0$/, '/s1'],
    [/^\/11$/, '/12'],
];

function subPathFor(p) {
    for (const [re, to] of SUB_RULES) {
        if (re.test(p)) return p.replace(re, to);
    }
    return null;
}

module.exports = { BUILT_IN_PATHS, loadSettings, orderedPaths, subPathFor };
