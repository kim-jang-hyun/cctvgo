'use strict';
const express = require('express');

/**
 * 영상 연결(WebRTC 시그널링) API. 브라우저의 SDP offer 를 로그인 확인 후 127.0.0.1 의 go2rtc 로만 넘긴다.
 * - go2rtc 에 보내는 스트림 이름은 streams.variantsOf(k) 에서만 나온다 (요청 값을 이름에 섞지 않는다).
 * - go2rtc 의 다른 관리 API 는 절대 넘기지 않는다 (스트림 추가는 명령 실행까지 가능하다).
 * - H.265 를 못 받는 브라우저: 원본 → 서브 → 변환본 순서. go2rtc 가 "codecs not matched" 로 거절했을 때만 다음으로 넘어간다.
 * 영상 자체는 이 서버(Cloudflare 터널)를 지나지 않고 go2rtc WebRTC 포트로 직접 간다.
 */

const K_RE = /^\d{1,4}$/;
const CODEC_MISMATCH_RE = /codecs not matched/i;

function registerLiveRoutes(app, { authMiddleware, streams, api, diag = { connection() {} } }) {
    const sdpBody = express.text({ type: 'application/sdp', limit: '32kb' });

    app.post('/api/live/:k/offer', authMiddleware, sdpBody, async (req, res) => {
        if (!K_RE.test(req.params.k)) return res.status(400).json({ status: 'error', message: '카메라 번호가 올바르지 않습니다.' });
        const sdp = typeof req.body === 'string' ? req.body : '';
        if (!sdp.trim()) return res.status(400).json({ status: 'error', message: '연결 정보가 없습니다.' });

        const k = Number(req.params.k);
        const h265 = req.query.h265 === '1';
        const started = Date.now();
        const record = (ok, variant, reason) => diag.connection({
            stage: 'signaling', k, ok, variant, reason, h265, ms: Date.now() - started,
            ua: req.headers['user-agent'] || '', ip: req.headers['cf-connecting-ip'] || req.ip || '',
        });

        const all = streams.variantsOf(k);
        if (all.length === 0) {
            record(false, null, 'not_found');
            return res.status(404).json({ status: 'error', reason: 'not_found', message: '카메라를 찾을 수 없습니다.' });
        }
        const tries = h265 ? all.filter(v => v.variant === 'main') : all;
        for (const { variant, name } of tries) {
            const r = await api.offer(name, sdp);
            if (r.ok) {
                record(true, variant, null);
                return res.json({ status: 'success', sdp: r.body, variant });
            }
            if (!(r.status === 500 && CODEC_MISMATCH_RE.test(r.body))) {
                record(false, variant, 'unavailable');
                return res.status(502).json({ status: 'error', reason: 'unavailable', message: '카메라 영상을 가져오지 못했습니다.' });
            }
        }
        record(false, null, 'codec');
        return res.status(415).json({ status: 'error', reason: 'codec', message: '이 브라우저에서는 이 카메라 영상(H.265)을 재생할 수 없습니다.' });
    });
}

module.exports = { registerLiveRoutes };
