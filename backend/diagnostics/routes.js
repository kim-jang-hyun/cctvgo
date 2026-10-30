'use strict';
const express = require('express');

/**
 * 진단 API.
 * - POST /api/live/report: 시청 화면이 연결 결과(성공/실패 원인, 후보 종류)를 알려 준다. 정해진 필드만 받는다.
 * - GET /api/diagnostics: 설정 화면 "진단 정보 복사"용 텍스트
 */

const OUTCOMES = new Set(['playing', 'failed']);
const REASONS = new Set(['network', 'codec', 'camera', 'signaling', 'disconnected']);
const VARIANTS = new Set(['main', 'sub', 'h264']);
const CAND_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp']);
const LOCAL_RE = /^(host|srflx|prflx|relay)\/(udp|tcp)$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v) : undefined);
const pick = (set, v) => (set.has(v) ? v : undefined);

function registerDiagRoutes(app, { authMiddleware, diag }) {
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
}

module.exports = { registerDiagRoutes };
