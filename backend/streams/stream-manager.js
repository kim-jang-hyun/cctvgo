'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 카메라 영상 켜기/끄기.
 * slots[카메라 순번] = 영상 번호(k). 출력은 hls\streamK\streamK.m3u8.
 * 삭제해도 다른 카메라의 번호는 그대로 두고, 새 카메라에는 지금까지 쓴 적 없는 번호를 준다
 * (번호가 바뀌면 그 카메라 영상까지 다시 켜야 해서 끊긴다).
 */
class StreamManager {
    constructor({ scriptDir, procs = require('./processes'), log = console.log }) {
        this.scriptDir = scriptDir;
        this.procs = procs;
        this.log = log;
        this.slots = [];
        this.maxUsed = 0;
    }

    /** 서비스 시작 시: 남아 있는 이 설치의 영상 프로세스를 정리하고 cctv.txt 순서대로 1..N 을 켠다 */
    async startAll(urls) {
        const list = await this.procs.listProcesses();
        for (const p of this._loopsFirst(list.filter(p => this.procs.isOurStreamProcess(p.commandLine, this.scriptDir)))) {
            await this.procs.killTree(p.pid);
        }
        const hls = path.join(this.scriptDir, 'hls');
        fs.rmSync(hls, { recursive: true, force: true });
        fs.mkdirSync(hls, { recursive: true });

        this.slots = [];
        this.maxUsed = 0;
        for (const url of urls) {
            const k = ++this.maxUsed;
            this._spawn(k, url);
            this.slots.push(k);
        }
        this.log(`[STREAM] 영상 ${urls.length}개 시작`);
    }

    async add(url) {
        const k = ++this.maxUsed;
        this._spawn(k, url);
        this.slots.push(k);
        return k;
    }

    async restart(index, url) {
        const k = this._slot(index);
        await this._stop(k);
        this._spawn(k, url);
    }

    async remove(index) {
        const k = this._slot(index);
        await this._stop(k);
        this.slots.splice(index, 1);
    }

    streamUrl(index) {
        const k = this.slots[index];
        return k ? `/hls/stream${k}/stream${k}.m3u8` : null;
    }

    _slot(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.slots.length) {
            throw new Error(`영상 순번이 올바르지 않습니다: ${index}`);
        }
        return this.slots[index];
    }

    _spawn(k, url) {
        this.procs.spawnStream({ scriptDir: this.scriptDir, k, url });
        this.log(`[STREAM] stream${k} 시작`);
    }

    // 루프 cmd 를 먼저 끄지 않으면 ffmpeg 가 꺼지자마자 루프가 다시 띄운다
    _loopsFirst(list) {
        const isLoop = p => /run_single_stream\.bat/i.test(p.commandLine);
        return [...list.filter(isLoop), ...list.filter(p => !isLoop(p))];
    }

    async _stop(k) {
        const list = await this.procs.listProcesses();
        for (const p of this._loopsFirst(list.filter(p => this.procs.matchesStream(p.commandLine, k, this.scriptDir)))) {
            await this.procs.killTree(p.pid);
        }
        this.log(`[STREAM] stream${k} 종료`);
    }
}

module.exports = { StreamManager };
