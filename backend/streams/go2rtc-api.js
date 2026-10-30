'use strict';

/**
 * 127.0.0.1 의 go2rtc 관리 API 클라이언트. 모든 요청에 Basic 인증을 붙인다.
 * 브라우저 요청을 이 API 로 그대로 넘기지 않는다 (스트림 추가는 exec: 로 명령 실행까지 가능하다).
 */
class Go2rtcApi {
    constructor({ port, username, password, fetchImpl = fetch, timeoutMs = 15000 }) {
        this.base = `http://127.0.0.1:${port}`;
        this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }

    _request(method, pathAndQuery, { body, contentType } = {}) {
        const headers = { Authorization: this.auth };
        if (contentType) headers['Content-Type'] = contentType;
        return this.fetchImpl(this.base + pathAndQuery, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    }

    /**
     * 스트림 추가 또는 갱신. PUT 은 go2rtc 가 설정 파일까지 고쳐 쓰다 실패(400)하고 이미 있는 이름도 거절한다.
     * PATCH 는 새 이름이면 추가, 있으면 갱신하고 설정 파일을 건드리지 않는다 (카메라 목록의 기준은 cctv.txt 하나)
     */
    async putStream(name, src) {
        const qs = new URLSearchParams({ name, src }).toString();
        const res = await this._request('PATCH', `/api/streams?${qs}`);
        if (!res.ok) throw new Error(`go2rtc 스트림 추가 실패 (${res.status})`);
    }

    async deleteStream(name) {
        const res = await this._request('DELETE', `/api/streams?${new URLSearchParams({ src: name })}`);
        if (!res.ok && res.status !== 404) throw new Error(`go2rtc 스트림 삭제 실패 (${res.status})`);
    }

    /** WebRTC offer 를 보내고 answer 를 받는다. 실패해도 예외 대신 { ok:false, status, body } (연결 실패는 status 0) */
    async offer(name, sdp) {
        try {
            const res = await this._request('POST', `/api/webrtc?${new URLSearchParams({ src: name })}`, { body: sdp, contentType: 'application/sdp' });
            const body = await res.text();
            return { ok: res.status === 200 || res.status === 201, status: res.status, body };
        } catch (e) {
            return { ok: false, status: 0, body: e.message };
        }
    }

    /** go2rtc 가 막 시작했을 때 API 가 응답할 때까지 기다린다 (포트를 열기 전에 보낸 요청은 실패한다) */
    async waitReady({ tries = 50, intervalMs = 200 } = {}) {
        for (let i = 0; i < tries; i++) {
            if (await this.ping()) return true;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return false;
    }

    async ping() {
        try {
            const res = await this._request('GET', '/api');
            return res.ok;
        } catch (e) {
            return false;
        }
    }
}

module.exports = { Go2rtcApi };
