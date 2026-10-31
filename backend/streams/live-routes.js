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

/**
 * go2rtc 답에 실제로 보내는 영상이 있는지. go2rtc 는 영상 코덱이 안 맞아도 음성만 맞으면 영상을 inactive 로 둔 답을
 * 성공(201)으로 준다 (H.265 카메라 + PC 크롬, 실기 확인). 그러면 화면은 까맣고 음성만 나오므로 코덱 불일치로 본다
 */
function answerHasVideo(sdp) {
    const section = String(sdp || '').split(/\r?\n(?=m=)/).find(x => /^m=video /.test(x));
    if (!section || /^m=video 0 /.test(section)) return false;
    return !/^a=(inactive|recvonly)\s*$/m.test(section);
}

function registerLiveRoutes(app, { authMiddleware, streams, api, diag = { connection() {} } }) {
    const sdpBody = express.text({ type: 'application/sdp', limit: '32kb' });

    app.post('/api/live/:k/offer', authMiddleware, sdpBody, async (req, res) => {
        if (!K_RE.test(req.params.k)) return res.status(400).json({ status: 'error', message: '카메라 번호가 올바르지 않습니다.' });
        const sdp = typeof req.body === 'string' ? req.body : '';
        if (!sdp.trim()) return res.status(400).json({ status: 'error', message: '연결 정보가 없습니다.' });

        // 서비스가 다시 시작해 카메라 번호가 바뀌었으면, 옛 번호로 다른 카메라에 붙지 않게 화면이 목록을 다시 받게 한다
        if (req.query.epoch !== streams.epoch) {
            return res.status(409).json({ status: 'error', reason: 'stale', message: '카메라 목록이 바뀌었습니다.' });
        }
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
            if (r.ok && answerHasVideo(r.body)) {
                record(true, variant, null);
                return res.json({ status: 'success', sdp: r.body, variant });
            }
            const codecMismatch = (r.ok && !answerHasVideo(r.body)) || (r.status === 500 && CODEC_MISMATCH_RE.test(r.body));
            if (!codecMismatch) {
                record(false, variant, 'unavailable');
                return res.status(502).json({ status: 'error', reason: 'unavailable', message: '카메라 영상을 가져오지 못했습니다.' });
            }
        }
        record(false, null, 'codec');
        return res.status(415).json({ status: 'error', reason: 'codec', message: '이 브라우저에서는 이 카메라 영상(H.265)을 재생할 수 없습니다.' });
    });
}

module.exports = { registerLiveRoutes };
