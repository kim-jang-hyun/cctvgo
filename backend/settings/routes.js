'use strict';
const { createRateLimiter } = require('../finder/guard');
const { MIN_LENGTH, MAX_LENGTH } = require('./password-store');

/**
 * 설정 화면 API. 이 파일에서 요청 본문(비밀번호)을 로그로 남기지 않는다.
 */
function registerSettingsRoutes(app, { authMiddleware, store }) {
    // 로그인된 기기를 잠깐 손에 넣은 사람이 현재 비밀번호를 맞혀 보는 것을 막는다 (사용자가 한 명이라 전체 공통)
    const passwordLimiter = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

    app.post('/api/settings/password', authMiddleware, (req, res) => {
        if (!passwordLimiter.allow('password')) {
            return res.status(429).json({ status: 'error', message: '시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.' });
        }
        const { currentPassword, newPassword } = req.body || {};
        let result;
        try {
            result = store.change(currentPassword, newPassword);
        } catch (error) {
            console.error('Password change failed:', error.message);
            return res.status(500).json({ status: 'error', message: '비밀번호를 저장하지 못했습니다.' });
        }

        if (result.ok) {
            req.session.passwordTag = store.tag();   // 바꾼 기기는 로그인 유지, 다른 기기는 옛 태그라 로그아웃된다
            return res.json({ status: 'success' });
        }
        switch (result.reason) {
            case 'wrong_current':
                return res.status(401).json({ status: 'error', message: '현재 비밀번호가 맞지 않습니다.' });
            case 'invalid_new':
                return res.status(400).json({ status: 'error', message: `새 비밀번호는 ${MIN_LENGTH}~${MAX_LENGTH}자로 입력하세요.` });
            default:
                return res.status(500).json({ status: 'error', message: '설정 파일(config.json)을 읽을 수 없습니다.' });
        }
    });
}

module.exports = { registerSettingsRoutes };
