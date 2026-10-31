'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENCODERS, probeEncoders, encoderTemplate, transcodeSource, encoderList } = require('../streams/encoder-probe');

test('변환기 시험 순서: Intel → NVIDIA → AMD 하드웨어, 그다음 Windows 내장 (libx264 없음)', () => {
    assert.deepEqual(ENCODERS, ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf']);
});

test('probeEncoders: 처음으로 성공한 변환기를 고르고, 각 시험은 testsrc2 로 짧게 돌린다', async () => {
    const calls = [];
    const run = async (cmd, args) => {
        calls.push({ cmd, args });
        return { code: args.includes('h264_amf') ? 0 : 1 };
    };
    const enc = await probeEncoders({ ffmpegPath: 'C:\\x\\ffmpeg.exe', run });
    assert.equal(enc, 'h264_amf');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(c => c.cmd === 'C:\\x\\ffmpeg.exe'));
    assert.ok(calls.every(c => c.args.join(' ').includes('testsrc2')));
    assert.deepEqual(calls.map(c => c.args[c.args.indexOf('-c:v') + 1]), ['h264_qsv', 'h264_nvenc', 'h264_amf']);
});

test('probeEncoders: 모두 실패하면 null', async () => {
    assert.equal(await probeEncoders({ ffmpegPath: 'f', run: async () => ({ code: 1 }) }), null);
});

test('probeEncoders: 실행 예외도 실패로 보고 다음을 시험한다', async () => {
    let n = 0;
    const enc = await probeEncoders({ ffmpegPath: 'f', run: async () => { if (n++ === 0) throw new Error('timeout'); return { code: 0 }; } });
    assert.equal(enc, 'h264_nvenc');
});

test('probeEncoders: Windows 내장 변환기는 소프트웨어 모드로 시험한다', async () => {
    const seen = [];
    await probeEncoders({ ffmpegPath: 'f', encoders: ['h264_mf'], run: async (c, args) => { seen.push(args.join(' ')); return { code: 0 }; } });
    assert.match(seen[0], /-c:v h264_mf -hw_encoding 0/);
});

test('encoderList: CCTVGO_ENCODERS 로 시험 목록을 바꿀 수 있고, 모르는 이름은 버린다', () => {
    assert.deepEqual(encoderList(undefined), ENCODERS);
    assert.deepEqual(encoderList('h264_mf'), ['h264_mf']);
    assert.deepEqual(encoderList('libx264, h264_amf ,h264_qsv'), ['h264_amf', 'h264_qsv']);
    assert.deepEqual(encoderList('nothing'), ENCODERS);
});

test('encoderTemplate: go2rtc h264 템플릿 (변환기별 옵션 + 4Mbps, GOP 20, B프레임 없음)', () => {
    assert.equal(encoderTemplate('h264_qsv'), '-c:v h264_qsv -look_ahead 0 -async_depth 1 -b:v 4M -g 20 -bf 0');
    assert.equal(encoderTemplate('h264_mf'), '-c:v h264_mf -hw_encoding 0 -rate_control cbr -b:v 4M -g 20 -bf 0');
    assert.equal(encoderTemplate('h264_nvenc'), '-c:v h264_nvenc -b:v 4M -g 20 -bf 0');
});

test('transcodeSource: go2rtc 의 원본 스트림을 받아 변환한다 (카메라에 따로 접속하지 않음, exec 아님)', () => {
    assert.equal(transcodeSource('cctvgo_k2'), 'ffmpeg:cctvgo_k2#video=h264');
});

test('encoderTemplate: Intel 변환은 프레임을 모아 두지 않는다 (지연 줄이기)', () => {
    assert.match(encoderTemplate('h264_qsv'), /-async_depth 1/);
});
