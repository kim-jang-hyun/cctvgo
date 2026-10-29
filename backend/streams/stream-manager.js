'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 카메라 영상 켜기/끄기.
 * entries = [{ k, url }]: 지금 켜 둔 영상(번호 k, 출력 hls\streamK\streamK.m3u8)과 그 카메라 주소.
 * 영상은 줄 순번이 아니라 카메라 주소로 찾는다. 그래서 cctv.txt 를 직접 고쳤거나 영상 적용이 한 번 실패해도
 * 다른 카메라의 영상을 끄지 않는다. 삭제해도 다른 카메라의 번호는 그대로 두고, 새 카메라에는 지금까지 쓴 적 없는 번호를 준다
 * (번호가 바뀌면 그 카메라 영상까지 다시 켜야 해서 끊긴다).
 * 모든 작업은 한 줄로 차례대로 실행한다 (시작 중에 들어온 추가가 시작 작업과 섞이지 않게).
 */
class StreamManager {
    constructor({ scriptDir, procs = require('./processes'), log = console.log, error = console.error }) {
        this.scriptDir = scriptDir;
        this.procs = procs;
        this.log = log;
        this.error = error;
        this.entries = [];
        this.maxUsed = 0;
        this.queue = Promise.resolve();
    }

    _run(task) {
        const result = this.queue.then(task);
        this.queue = result.catch(() => {});
        return result;
    }

    /** 서비스 시작 시: 남아 있는 이 설치의 영상 프로세스를 정리하고 cctv.txt 순서대로 1..N 을 켠다. 정리가 실패해도 영상은 켠다 */
    startAll(urls) {
        return this._run(async () => {
            try {
                const list = await this.procs.listProcesses();
                for (const p of this._loopsFirst(list.filter(p => this.procs.isOurStreamProcess(p.commandLine, this.scriptDir)))) {
                    await this.procs.killTree(p.pid);
                }
            } catch (e) {
                this.error(`[STREAM] 이전 영상 정리 실패: ${e.message}`);
            }
            const hls = path.join(this.scriptDir, 'hls');
            try {
                // 방금 끈 ffmpeg 가 파일을 아직 쥐고 있을 수 있어 몇 번 다시 시도한다
                fs.rmSync(hls, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
                fs.mkdirSync(hls, { recursive: true });
            } catch (e) {
                this.error(`[STREAM] hls 폴더 정리 실패: ${e.message}`);
            }

            this.entries = [];
            this.maxUsed = 0;
            for (const url of urls) {
                const entry = { k: ++this.maxUsed, url };
                this.entries.push(entry);
                try { this._spawn(entry); } catch (e) { this.error(`[STREAM] stream${entry.k} 실행 실패: ${e.message}`); }
            }
            this.log(`[STREAM] 영상 ${urls.length}개 시작`);
        });
    }

    /** 대응표에 먼저 넣고 켠다 (실행이 실패해도 cctv.txt 와 대응표가 어긋나지 않게) */
    add(url) {
        return this._run(async () => {
            const entry = { k: ++this.maxUsed, url };
            this.entries.push(entry);
            this._spawn(entry);
            return entry.k;
        });
    }

    /** oldUrl 카메라의 영상을 같은 번호로 newUrl 로 다시 켠다. 켜져 있지 않던 카메라면 새로 켠다 */
    restart(oldUrl, newUrl) {
        return this._run(async () => {
            const entry = this.entries.find(e => e.url === oldUrl);
            if (!entry) {
                const fresh = { k: ++this.maxUsed, url: newUrl };
                this.entries.push(fresh);
                this._spawn(fresh);
                return;
            }
            entry.url = newUrl;
            await this._stop(entry.k);
            this._spawn(entry);
        });
    }

    /** 대응표에서 먼저 빼고 끈다. 켜져 있지 않던 카메라면 아무것도 하지 않는다 */
    remove(url) {
        return this._run(async () => {
            const i = this.entries.findIndex(e => e.url === url);
            if (i < 0) return;
            const [entry] = this.entries.splice(i, 1);
            await this._stop(entry.k);
        });
    }

    /** cctv.txt 의 카메라 주소 목록에 맞는 영상 주소 목록. 같은 주소가 여러 줄이면 앞에서부터 하나씩 짝짓는다 */
    streamUrls(urls) {
        const used = new Set();
        return urls.map(url => {
            const entry = this.entries.find(e => e.url === url && !used.has(e));
            if (!entry) return null;
            used.add(entry);
            return `/hls/stream${entry.k}/stream${entry.k}.m3u8`;
        });
    }

    _spawn({ k, url }) {
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
