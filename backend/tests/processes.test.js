'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesStream, isOurStreamProcess } = require('../streams/processes');

const DIR = 'C:\\cctvgo\\package';
const FFMPEG10 = 'C:\\cctvgo\\package\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -fflags +genpts -rtsp_transport tcp -i rtsp://a:b@192.168.0.5:554/x -c:v copy -f hls hls\\stream10\\stream10.m3u8';
const LOOP1 = 'cmd /c "C:\\cctvgo\\package\\run_single_stream.bat "hls\\stream1" "stream1.m3u8" "5" >> "C:\\cctvgo\\package\\logs\\stream_1.log" 2>&1"';
const FFMPEG1 = 'C:\\cctvgo\\package\\ffmpeg\\bin\\cctvgo-ffmpeg.exe -i rtsp://a:b@192.168.0.5:554/x -f hls hls\\stream1\\stream1.m3u8';

test('matchesStream: stream1 은 stream10/stream11 과 구별된다', () => {
    assert.equal(matchesStream(FFMPEG10, 1, DIR), false);
    assert.equal(matchesStream(LOOP1, 1, DIR), true);
    assert.equal(matchesStream(FFMPEG1, 1, DIR), true);
    assert.equal(matchesStream(FFMPEG10, 10, DIR), true);
    assert.equal(matchesStream(LOOP1.replace(/stream1/g, 'stream11'), 1, DIR), false);
});

test('matchesStream: 대소문자를 구분하지 않는다', () => {
    assert.equal(matchesStream(FFMPEG1.toUpperCase(), 1, DIR), true);
});

test('matchesStream/isOurStreamProcess: 다른 설치 폴더의 프로세스는 대상이 아니다', () => {
    assert.equal(matchesStream(FFMPEG1, 1, 'C:\\cctvgo'), false);
    assert.equal(isOurStreamProcess(FFMPEG1, 'C:\\cctvgo'), false);
    assert.equal(isOurStreamProcess(LOOP1, 'C:\\cctvgo'), false);
    assert.equal(matchesStream(FFMPEG1, 1, 'C:\\cctvgo\\package\\'), true);
});

test('isOurStreamProcess: 이 폴더의 run_single_stream 과 ffmpeg 만 대상이다', () => {
    assert.equal(isOurStreamProcess(LOOP1, DIR), true);
    assert.equal(isOurStreamProcess(FFMPEG10, DIR), true);
    assert.equal(isOurStreamProcess('cmd /c C:\\cctvgo\\package\\cctvgo-service.exe', DIR), false);
    assert.equal(isOurStreamProcess(null, DIR), false);
});

test('실제 명령줄 형태 (따옴표로 감싼 ffmpeg 경로, start /b 로 띄운 cmd) 도 찾는다', () => {
    const ff = '"C:\\cctvgo\\package\\ffmpeg\\bin\\cctvgo-ffmpeg.exe"  -fflags +genpts -rtsp_transport tcp -i rtsp://a:b@192.168.0.5:554/x -c:v copy -an -f hls hls\\stream1\\stream1.m3u8';
    const loop = 'cmd  /c "C:\\cctvgo\\package\\run_single_stream.bat "hls\\stream1" "stream1.m3u8" "5" "';
    const service = 'cmd  /c "C:\\cctvgo\\package\\cctvgo-service.exe >> C:\\cctvgo\\package\\logs\\service.log 2>&1"';
    assert.equal(matchesStream(ff, 1, DIR), true);
    assert.equal(matchesStream(loop, 1, DIR), true);
    assert.equal(isOurStreamProcess(service, DIR), false);
});
