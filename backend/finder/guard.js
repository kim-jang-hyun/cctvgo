'use strict';
const fs = require('fs');

/**
 * 카메라 주소 찾기 안전장치 모음
 * - 사설 IP 판정 (외부 IP 스캔/접속 방지)
 * - IP별 인증 실패 예산 (카메라 계정 잠금 방지)
 * - 요청 횟수 제한, 동시 실행 잠금
 */

const OCTET = '(0|[1-9]\\d{0,2})';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

function ipv4Parts(ip) {
    if (typeof ip !== 'string') return null;
    const m = IPV4_RE.exec(ip);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.some(p => p > 255) ? null : parts;
}

/** 10.x.x.x, 172.16-31.x.x, 192.168.x.x 만 true */
function isPrivateIPv4(ip) {
    const p = ipv4Parts(ip);
    if (!p) return false;
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
}

/**
 * IP별 인증 실패 횟수. 마지막 실패로부터 lockMs가 지나면 초기화된다.
 * persistPath 가 있으면 서비스를 재시작해도 30분 창이 유지되도록 파일({ ip: { count, last } })에 저장한다 (계정 잠금 방지).
 */
class AuthBudget {
    constructor({ max = 2, lockMs = 30 * 60 * 1000, now = Date.now, persistPath = null } = {}) {
        this.max = max;
        this.lockMs = lockMs;
        this.now = now;
        this.map = new Map();
        this.persistPath = persistPath;
        if (persistPath) this._load();
    }

    _load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) return;
            const t = this.now();
            for (const [ip, e] of Object.entries(data)) {
                if (!e || !Number.isInteger(e.count) || e.count < 1 || !Number.isFinite(e.last)) continue;
                const last = Math.min(e.last, t);   // 시계가 되돌려졌어도 잠금이 무한정 늘어나지 않게 한다
                if (t - last >= this.lockMs) continue;
                this.map.set(ip, { count: e.count, last });
            }
        } catch (error) { /* 파일이 없거나 깨졌으면 빈 상태로 시작 */ }
    }

    /** best-effort 저장 (만료 항목 제외). 실패해도 예외를 내지 않고 경로 없이 한 줄만 남긴다. */
    _save() {
        if (!this.persistPath) return;
        try {
            const out = {};
            for (const ip of Array.from(this.map.keys())) {
                const e = this._entry(ip);
                if (e) out[ip] = { count: e.count, last: e.last };
            }
            const tmp = this.persistPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
            fs.renameSync(tmp, this.persistPath);
        } catch (error) {
            console.error('Finder 인증 실패 기록 저장 실패:', error.code || 'error');
        }
    }

    _entry(ip) {
        const e = this.map.get(ip);
        if (e && this.now() - e.last >= this.lockMs) {
            this.map.delete(ip);
            return null;
        }
        return e || null;
    }

    failures(ip) {
        const e = this._entry(ip);
        return e ? e.count : 0;
    }

    remaining(ip) {
        return Math.max(0, this.max - this.failures(ip));
    }

    isExhausted(ip) {
        return this.remaining(ip) === 0;
    }

    retryAfterMs(ip) {
        const e = this._entry(ip);
        if (!e || e.count < this.max) return 0;
        return Math.max(0, e.last + this.lockMs - this.now());
    }

    recordFailure(ip) {
        const e = this._entry(ip) || { count: 0, last: 0 };
        e.count += 1;
        e.last = this.now();
        this.map.set(ip, e);
        this._save();
        return this.remaining(ip);
    }

    reset(ip) {
        if (this.map.delete(ip)) this._save();
    }
}

/** key별 고정 윈도우 요청 제한 */
function createRateLimiter({ max, windowMs, now = Date.now }) {
    const hits = new Map();
    return {
        allow(key) {
            const t = now();
            const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
            if (recent.length >= max) {
                hits.set(key, recent);
                return false;
            }
            recent.push(t);
            hits.set(key, recent);
            return true;
        },
    };
}

/** 동시에 하나만 실행 */
function createLock() {
    let held = false;
    return {
        tryAcquire() {
            if (held) return false;
            held = true;
            return true;
        },
        release() {
            held = false;
        },
    };
}

module.exports = { isPrivateIPv4, AuthBudget, createRateLimiter, createLock };
