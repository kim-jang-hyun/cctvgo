'use strict';
const crypto = require('crypto');
const fs = require('fs');

/**
 * config.json 의 로그인 비밀번호를 읽고 바꾼다.
 * 비밀번호를 잊으면 서버 PC 에서 config.json 을 직접 고쳐 복구하므로 평문으로 둔다.
 *
 * tag() 는 비밀번호에서 만든 값으로, 로그인할 때 세션에 넣어 두고 요청마다 비교한다.
 * 비밀번호가 바뀌면(화면에서든 config.json 직접 수정이든) 옛 태그를 가진 세션은 모두 로그아웃된다.
 */

// 주소(고객ID.cctvgo.app)는 짐작할 수 있으므로 1234 같은 짧은 비밀번호는 받지 않는다.
// 이미 쓰던 짧은 비밀번호로 로그인하는 것은 그대로 된다 (바꿀 때만 검사)
const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

function tagOf(password) {
    return crypto.createHash('sha256').update('cctvgo-session:' + password).digest('hex').slice(0, 32);
}

function isValidNewPassword(value) {
    return typeof value === 'string'
        && value.length >= MIN_LENGTH
        && value.length <= MAX_LENGTH
        && !/[\x00-\x1f\x7f]/.test(value);
}

function createPasswordStore(configPath) {
    // 영상(HLS) 요청마다 인증을 확인하므로 파일 내용은 수정 시각/크기가 바뀔 때만 다시 읽는다
    let cache = null;   // { key, config, tag }

    function load() {
        let stat;
        try {
            stat = fs.statSync(configPath);
        } catch (e) {
            cache = null;
            return null;
        }
        const key = `${stat.mtimeMs}:${stat.size}`;
        if (cache && cache.key === key) return cache;
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const password = typeof config.password === 'string' ? config.password : null;
            cache = { key, config, password, tag: password === null ? null : tagOf(password) };
        } catch (e) {
            console.error('Failed to read config.json:', e.message);
            cache = null;
        }
        return cache;
    }

    return {
        get() {
            return load()?.password ?? null;
        },

        tag() {
            return load()?.tag ?? null;
        },

        /** @returns {{ ok: true } | { ok: false, reason: 'wrong_current' | 'invalid_new' | 'no_config' }} */
        change(currentPassword, newPassword) {
            const loaded = load();
            if (!loaded || loaded.password === null) return { ok: false, reason: 'no_config' };
            if (currentPassword !== loaded.password) return { ok: false, reason: 'wrong_current' };
            if (!isValidNewPassword(newPassword)) return { ok: false, reason: 'invalid_new' };

            const text = JSON.stringify({ ...loaded.config, password: newPassword }, null, 2) + '\n';
            const tmp = configPath + '.tmp';
            fs.writeFileSync(tmp, text, 'utf8');
            fs.renameSync(tmp, configPath);
            cache = null;
            return { ok: true };
        },
    };
}

module.exports = { createPasswordStore, MIN_LENGTH, MAX_LENGTH };
