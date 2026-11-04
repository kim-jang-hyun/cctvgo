'use strict';

/**
 * 로그인 비밀번호 맞혀 보기 막기.
 * 같은 접속자가 연속으로 max 번 틀리면 마지막 실패부터 lockMs 동안 그 접속자의 로그인을 막는다.
 * 전체 공통 잠금은 두지 않는다: 남이 일부러 계속 틀려 주인까지 못 들어오게 만들 수 있어서다.
 * 이미 로그인한 세션과 영상은 건드리지 않는다.
 */
function createLoginGuard({ max = 5, lockMs = 15 * 60 * 1000, now = Date.now } = {}) {
    const map = new Map();   // key -> { count, last }

    function prune() {
        const t = now();
        for (const [k, e] of map) if (t - e.last >= lockMs) map.delete(k);
    }

    function entry(key) {
        const e = map.get(key);
        if (e && now() - e.last >= lockMs) {
            map.delete(key);
            return null;
        }
        return e || null;
    }

    return {
        /** 막혀 있으면 남은 시간(ms), 아니면 0 */
        retryAfterMs(key) {
            const e = entry(key);
            if (!e || e.count < max) return 0;
            return Math.max(0, e.last + lockMs - now());
        },
        recordFailure(key) {
            prune();
            const e = entry(key) || { count: 0, last: 0 };
            e.count += 1;
            e.last = now();
            map.set(key, e);
        },
        reset(key) {
            map.delete(key);
        },
        size() {
            return map.size;
        },
    };
}

function stripV4Mapped(addr) {
    return typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/**
 * 접속자 구분값.
 * 외부 접속은 cloudflared 가 같은 PC(127.0.0.1)에서 넘겨주고, Cloudflare 가 실제 접속자 IP 를 CF-Connecting-IP 에 넣는다
 * (접속자가 보낸 값은 Cloudflare 가 덮어쓴다). 공유기 안에서 바로 온 요청은 이 머리글을 꾸밀 수 있으므로 믿지 않는다.
 */
function clientKey(req) {
    const remote = stripV4Mapped(req.socket && req.socket.remoteAddress) || 'unknown';
    const cf = req.headers && req.headers['cf-connecting-ip'];
    if (LOOPBACK.has(remote) && typeof cf === 'string' && cf.trim()) return cf.trim();
    return remote;
}

/** 로그인 API. 이 함수에서 요청 본문(비밀번호)을 로그로 남기지 않는다. */
function registerLoginRoute(app, { store, guard = createLoginGuard() }) {
    app.post('/login', (req, res) => {
        const key = clientKey(req);
        const wait = guard.retryAfterMs(key);
        if (wait > 0) {
            const minutes = Math.ceil(wait / 60000);
            res.set('Retry-After', String(Math.ceil(wait / 1000)));
            return res.status(429).send(`비밀번호를 여러 번 틀렸습니다. ${minutes}분 뒤에 다시 시도하세요.`);
        }

        const password = store.get();
        if (password === null) return res.status(500).send('Config not found');

        const inputPassword = req.body && req.body.password;
        if (typeof inputPassword === 'string' && inputPassword === password) {
            guard.reset(key);
            req.session.authenticated = true;
            req.session.passwordTag = store.tag();
            return res.sendStatus(200);
        }
        guard.recordFailure(key);
        console.log(`[LOGIN] 비밀번호 틀림: ${key}`);
        return res.status(401).send('비밀번호가 틀렸습니다.');
    });
}

module.exports = { createLoginGuard, clientKey, registerLoginRoute };
