'use strict';
const { streamNames } = require('./go2rtc-config');

/**
 * 카메라 영상 켜기/끄기 (go2rtc 스트림).
 * entries = [{ k, url, subUrl }]: 카메라 번호 k 와 카메라 주소. go2rtc 이름은 s{k}(원본), s{k}_sub(서브), s{k}_h264(PC 변환본).
 * 영상은 줄 순번이 아니라 카메라 주소로 찾는다. 그래서 cctv.txt 를 직접 고쳤거나 영상 적용이 한 번 실패해도
 * 다른 카메라의 영상을 끄지 않는다. 삭제해도 다른 카메라의 번호는 그대로 두고, 새 카메라에는 지금까지 쓴 적 없는 번호를 준다
 * (번호가 바뀌면 그 카메라 영상까지 다시 연결해야 해서 끊긴다).
 * 모든 작업은 한 줄로 차례대로 실행한다. 로그에는 카메라 주소(비밀번호 포함)를 남기지 않는다.
 */
class StreamManager {
    constructor({ api, transcodeSource = () => null, log = console.log, error = console.error }) {
        this.api = api;
        this.transcodeSource = transcodeSource;
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

    /** 이 카메라의 go2rtc 스트림 표 { 이름: 소스 } */
    _streamsOf({ k, url, subUrl }) {
        const n = streamNames(k);
        const out = { [n.main]: url };
        if (subUrl) out[n.sub] = subUrl;
        const tr = this.transcodeSource(url);
        if (tr) out[n.h264] = tr;
        return out;
    }

    async _put(entry) {
        for (const [name, src] of Object.entries(this._streamsOf(entry))) await this.api.putStream(name, src);
    }

    /** 서비스 시작 시: cctv.txt 순서대로 1..N 을 배정하고 go2rtc 시작 설정에 넣을 스트림 표를 돌려준다 */
    initialStreams(cameras) {
        this.entries = [];
        this.maxUsed = 0;
        const all = {};
        for (const c of cameras) {
            const entry = { k: ++this.maxUsed, url: c.url, subUrl: c.subUrl || null };
            this.entries.push(entry);
            Object.assign(all, this._streamsOf(entry));
        }
        this.log(`[STREAM] 영상 ${cameras.length}개 준비`);
        return all;
    }

    /** 지금의 스트림 표 (go2rtc 가 죽었다 다시 뜰 때 설정 파일로 쓴다. 시작 뒤 추가·수정·삭제가 반영돼 있다) */
    currentStreams() {
        const all = {};
        for (const entry of this.entries) Object.assign(all, this._streamsOf(entry));
        return all;
    }

    /** 변환기 선택이 끝난 뒤 바꾼다. 적용은 resync() 로 한다 */
    setTranscodeSource(fn) {
        this.transcodeSource = fn;
    }

    /** go2rtc 가 다시 시작됐거나 변환기가 정해졌을 때 대응표 전체를 다시 넣는다 */
    resync() {
        return this._run(async () => {
            for (const entry of this.entries) {
                try { await this._put(entry); } catch (e) { this.error(`[STREAM] stream${entry.k} 다시 적용 실패: ${e.message}`); }
            }
            this.log(`[STREAM] 영상 ${this.entries.length}개 다시 적용`);
        });
    }

    /** 대응표에 먼저 넣고 켠다 (실행이 실패해도 cctv.txt 와 대응표가 어긋나지 않게) */
    add(url, subUrl = null) {
        return this._run(async () => {
            const entry = { k: ++this.maxUsed, url, subUrl: subUrl || null };
            this.entries.push(entry);
            await this._put(entry);
            this.log(`[STREAM] stream${entry.k} 시작`);
            return entry.k;
        });
    }

    /** oldUrl 카메라의 영상을 같은 번호로 newUrl 로 바꾼다. 켜져 있지 않던 카메라면 새로 켠다 */
    restart(oldUrl, newUrl, newSubUrl = null) {
        return this._run(async () => {
            let entry = this.entries.find(e => e.url === oldUrl);
            if (!entry) {
                entry = { k: ++this.maxUsed, url: newUrl, subUrl: newSubUrl || null };
                this.entries.push(entry);
                await this._put(entry);
                this.log(`[STREAM] stream${entry.k} 시작`);
                return;
            }
            const hadSub = !!entry.subUrl;
            entry.url = newUrl;
            entry.subUrl = newSubUrl || null;
            await this._put(entry);
            if (hadSub && !entry.subUrl) await this.api.deleteStream(streamNames(entry.k).sub);
            this.log(`[STREAM] stream${entry.k} 다시 시작`);
        });
    }

    /** 대응표에서 먼저 빼고 끈다. 켜져 있지 않던 카메라면 아무것도 하지 않는다 */
    remove(url) {
        return this._run(async () => {
            const i = this.entries.findIndex(e => e.url === url);
            if (i < 0) return;
            const [entry] = this.entries.splice(i, 1);
            for (const name of Object.values(streamNames(entry.k))) await this.api.deleteStream(name);
            this.log(`[STREAM] stream${entry.k} 종료`);
        });
    }

    /** cctv.txt 의 카메라 주소 목록에 맞는 카메라 번호 목록. 같은 주소가 여러 줄이면 앞에서부터 하나씩 짝짓는다 */
    streamIds(urls) {
        const used = new Set();
        return urls.map(url => {
            const entry = this.entries.find(e => e.url === url && !used.has(e));
            if (!entry) return null;
            used.add(entry);
            return entry.k;
        });
    }

    /** 브라우저에 보낼 때 시도할 스트림 순서: 원본 → 서브 → 변환본 */
    variantsOf(k) {
        const entry = this.entries.find(e => e.k === k);
        if (!entry) return [];
        const n = streamNames(k);
        const list = [{ variant: 'main', name: n.main }];
        if (entry.subUrl) list.push({ variant: 'sub', name: n.sub });
        if (this.transcodeSource(entry.url)) list.push({ variant: 'h264', name: n.h264 });
        return list;
    }
}

module.exports = { StreamManager };
