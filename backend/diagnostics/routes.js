'use strict';
const express = require('express');
const { createZip } = require('./bundle');

/**
 * 진단 API.
 * - POST /api/live/report: 시청 화면이 연결 결과(성공/실패 원인, 후보 종류)를 알려 준다. 정해진 필드만 받는다.
 * - GET /api/diagnostics: 설정 화면 "진단 정보 복사"용 텍스트
 * - GET /api/diagnostics/bundle: 설정 화면 "진단 파일 받기"용 zip (로그·PC 정보 등, 비밀번호 제외)
 */

const OUTCOMES = new Set(['playing', 'failed']);
const REASONS = new Set(['network', 'codec', 'camera', 'media_server', 'signaling', 'disconnected']);
const VARIANTS = new Set(['main', 'sub', 'h264']);
const CAND_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp']);
const LOCAL_RE = /^(host|srflx|prflx|relay)\/(udp|tcp)$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v) : undefined);
const pick = (set, v) => (set.has(v) ? v : undefined);

function registerDiagRoutes(app, { authMiddleware, diag, bundle = null }) {
    app.post('/api/live/report', authMiddleware, express.json({ limit: '2kb', type: () => true }), (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const k = Number.isInteger(b.k) && b.k >= 0 && b.k < 10000 ? b.k : undefined;
        const p = b.pair && typeof b.pair === 'object' ? b.pair : null;
        diag.connection({
            stage: 'browser',
            k,
            ok: b.outcome === 'playing',
            outcome: pick(OUTCOMES, b.outcome),
            reason: pick(REASONS, b.reason),
            variant: pick(VARIANTS, b.variant),
            h265: typeof b.h265 === 'boolean' ? b.h265 : undefined,
            ms: num(b.ms),
            status: num(b.status),
            local: Array.isArray(b.local) ? b.local.filter(x => typeof x === 'string' && LOCAL_RE.test(x)).slice(0, 10) : undefined,
            pair: p ? { local: pick(CAND_TYPES, p.local), remote: pick(CAND_TYPES, p.remote), protocol: pick(PROTOCOLS, p.protocol) } : undefined,
            ua: req.headers['user-agent'] || '',
            ip: req.headers['cf-connecting-ip'] || req.ip || '',
        });
        res.sendStatus(204);
    });

    app.get('/api/diagnostics', authMiddleware, (req, res) => {
        res.json({ status: 'success', text: diag.text() });
    });

    let building = false;   // 로그를 모으는 동안 같은 요청이 겹치지 않게
    app.get('/api/diagnostics/bundle', authMiddleware, async (req, res) => {
        if (!bundle) return res.status(404).json({ status: 'error', message: '진단 파일을 만들 수 없습니다.' });
        if (building) return res.status(409).json({ status: 'error', message: '진단 파일을 만드는 중입니다. 잠시 후 다시 시도하세요.' });
        building = true;
        try {
            const zip = createZip(await bundle());
            const d = new Date();
            const p = n => String(n).padStart(2, '0');
            const name = `cctvgo-diagnostics-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.setHeader('Cache-Control', 'no-store');
            res.end(zip);
        } catch (e) {
            console.error('Diagnostics bundle failed:', e.message);
            // 5xx 는 Cloudflare 가 오류 페이지로 바꾸므로 쓰지 않는다
            res.status(422).json({ status: 'error', message: '진단 파일을 만들지 못했습니다.' });
        } finally {
            building = false;
        }
    });
}

module.exports = { registerDiagRoutes };
