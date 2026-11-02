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

// 원본/서브가 코덱 때문에 안 됐던 카메라는 이 시간 동안 성공했던 단계부터 시도한다 (지나면 카메라 설정이 바뀌었을 수 있어 처음부터)
const LEARN_TTL_MS = 10 * 60 * 1000;

function registerLiveRoutes(app, { authMiddleware, streams, api, diag = { connection() {} }, now = Date.now }) {
    const sdpBody = express.text({ type: 'application/sdp', limit: '32kb' });
    // "카메라 번호 + 브라우저의 H.265 지원 여부" → 성공한 단계(variant). 매번 원본·서브부터 시도하면 그때마다
    // go2rtc 가 카메라에 새로 접속해 카메라 동시 접속이 몰리고 첫 화면도 늦어진다
    const learned = new Map();

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
        const key = `${streams.epoch}:${k}:${h265 ? 1 : 0}`;
        const memo = learned.get(key);
        const startAt = memo && now() - memo.at < LEARN_TTL_MS ? Math.max(0, all.findIndex(v => v.variant === memo.variant)) : 0;
        const tries = (h265 ? all.filter(v => v.variant === 'main') : all).slice(h265 ? 0 : startAt);
        for (const { variant, name } of tries) {
            const r = await api.offer(name, sdp);
            if (r.ok && answerHasVideo(r.body)) {
                if (variant !== 'main') learned.set(key, { variant, at: now() });
                else learned.delete(key);
                record(true, variant, null);
                return res.json({ status: 'success', sdp: r.body, variant });
            }
            const codecMismatch = (r.ok && !answerHasVideo(r.body)) || (r.status === 500 && CODEC_MISMATCH_RE.test(r.body));
            if (!codecMismatch) {
                // go2rtc 에 아예 닿지 않으면(실행 안 됨, 백신 차단 등) 카메라 문제와 구분해 알린다
                if (r.status === 0 && !(await api.ping())) {
                    record(false, variant, 'media_server');
                    return res.status(424).json({ status: 'error', reason: 'media_server', message: '영상 서버가 실행되지 않고 있습니다.' });
                }
                record(false, variant, 'unavailable');
                // 5xx 는 쓰지 않는다: Cloudflare 가 5xx 응답을 자기 오류 페이지로 바꿔 화면이 이유를 읽지 못한다
                return res.status(424).json({ status: 'error', reason: 'unavailable', message: '카메라 영상을 가져오지 못했습니다.' });
            }
        }
        record(false, null, 'codec');
        return res.status(415).json({ status: 'error', reason: 'codec', message: '이 브라우저에서는 이 카메라 영상(H.265)을 재생할 수 없습니다.' });
    });
}

module.exports = { registerLiveRoutes };
