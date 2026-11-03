'use strict';
const fs = require('fs');
const path = require('path');
const { isPrivateIPv4, createRateLimiter, createLock } = require('./guard');
const { parseCameras, parseRtspUrl, saveCameras, withCredentials } = require('./cctv-file');
const { cameraKeys, resolveLayout, moveSlot, layoutVersion, loadLayout, saveLayout, gridColumns } = require('./layout');

/**
 * 카메라 관리 API (목록/추가/수정/삭제) 와 영상 화면용 채널 목록.
 * cctv.txt 를 바꾸면 그 카메라 영상만 켜거나 끄거나 다시 켠다 (다른 영상은 건드리지 않는다).
 * 이 파일에서 요청 본문(비밀번호 포함)이나 카메라 주소를 로그로 남기지 않는다.
 */

function registerCameraRoutes(app, { authMiddleware, cctvPath, streams, shared }) {
    const { newBudget, probingIps, probeLimiter, doFind, settings, keyOf } = shared;
    const writeLock = createLock();
    const writeLimiter = createRateLimiter({ max: 20, windowMs: 60 * 1000 });

    const bad = (res, message) => res.status(400).json({ status: 'error', message });
    const conflict = (res, message) => res.status(409).json({ status: 'error', message });
    const tooMany = res => res.status(429).json({ status: 'error', message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    const readCameras = () => parseCameras(fs.existsSync(cctvPath) ? fs.readFileSync(cctvPath, 'utf8') : '');
    const layoutPath = path.join(path.dirname(cctvPath), 'layout.json');
    const maskedUrl = url => url.replace(/^(rtsp:\/\/[^:@/]*):[^@]*@/, '$1:****@');

    function urlError(url) {
        if (typeof url !== 'string' || url.length > 500) return '카메라 주소가 올바르지 않습니다.';
        if (/[\s,]/.test(url)) return '카메라 주소에 공백이나 쉼표(,)를 넣을 수 없습니다.';
        if (/["^<>|\x00-\x1f\x7f]/.test(url)) return '카메라 주소에 사용할 수 없는 문자가 있습니다.';
        // rtsp:// 뒤 첫 / 전까지(authority)에 @ 가 둘 이상이면 파서마다 호스트를 다르게 해석할 수 있어 거부한다
        const authority = url.replace(/^rtsp:\/\//i, '').split('/')[0];
        if (authority.split('@').length > 2) return '카메라 주소 형식이 올바르지 않습니다.';
        let parsed;
        try { parsed = new URL(url); } catch (e) { return '카메라 주소가 올바르지 않습니다.'; }
        if (parsed.protocol !== 'rtsp:' || !isPrivateIPv4(parsed.hostname)) return 'rtsp:// 로 시작하는 사설 IP 주소만 저장할 수 있습니다.';
        return null;
    }

    /** 서브 스트림 주소: 메인과 같은 카메라(IP)의 rtsp 주소만 받는다 */
    function subUrlError(subUrl, url) {
        if (subUrl === undefined || subUrl === null || subUrl === '') return null;
        const e = urlError(subUrl);
        if (e) return `서브 스트림 ${e}`;
        if (parseRtspUrl(subUrl)?.host !== parseRtspUrl(url)?.host) return '서브 스트림 주소가 이 카메라와 맞지 않습니다.';
        return null;
    }

    function textError(fields) {
        for (const [label, v] of fields) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200)) return `${label} 형식이 올바르지 않습니다.`;
        }
        return null;
    }

    /**
     * cctv.txt 를 고친 뒤 영상에 적용한다. 파일 쓰기와 영상 적용은 한 번에 하나만.
     * 파일 쓰기가 실패하면 영상은 건드리지 않는다. 영상 적용만 실패하면 applied:false 로 알린다.
     * 응답을 이미 보냈으면 null.
     */
    async function commit(req, res, op, apply) {
        if (!writeLimiter.allow(keyOf(req))) { tooMany(res); return null; }
        if (!writeLock.tryAcquire()) { conflict(res, '다른 변경을 처리 중입니다. 잠시 후 다시 시도하세요.'); return null; }
        try {
            let result;
            try {
                result = saveCameras(cctvPath, op);
            } catch (error) {
                if (error.code === 'CONFLICT' || error.code === 'DUPLICATE') { conflict(res, error.message); return null; }
                console.error('Camera save failed:', error.message);
                res.status(500).json({ status: 'error', message: 'cctv.txt 저장에 실패했습니다.' });
                return null;
            }
            let applied = true;
            try {
                await apply(result);
            } catch (error) {
                applied = false;
                console.error('Camera stream apply failed:', error.message);
            }
            console.log(`[CAMERA] cctv.txt ${op.type} 완료 (index=${result.index}, 영상 적용=${applied ? '성공' : '실패'})`);
            return { index: result.index, applied };
        } finally {
            writeLock.release();
        }
    }

    /** 지금 cctv.txt 와 저장된 배치로 만든 칸 배치 (카메라 키 또는 null) */
    function currentLayout(cameras) {
        return resolveLayout(loadLayout(layoutPath), cameraKeys(cameras.map(c => c.url)));
    }

    /** 영상 화면용 목록: 영상 주소 대신 카메라 번호(stream)와 칸 번호(slot)를 준다. 화면은 이 번호로 /api/live/:k/offer 에 연결한다 */
    function channelList(cameras, slots = currentLayout(cameras)) {
        const ids = streams.streamIds(cameras.map(c => c.url));
        const keys = cameraKeys(cameras.map(c => c.url));
        const channels = cameras.map((c, i) => ({ name: c.name || `카메라 ${c.index + 1}`, stream: ids[i], slot: slots.indexOf(keys[i]) }));
        return { epoch: streams.epoch, columns: gridColumns(cameras.length), layout: layoutVersion(slots), channels };
    }

    // 영상 칸 옮기기: from 칸의 카메라를 to 칸으로 (빈 칸이면 이동, 카메라가 있으면 맞바꿈). 영상은 건드리지 않는다.
    // layout: 화면이 받은 배치 버전. 다른 기기에서 이미 바꿨으면 409 로 알려 화면이 목록을 다시 받게 한다
    app.post('/api/layout/move', authMiddleware, (req, res) => {
        if (!writeLimiter.allow(keyOf(req))) return tooMany(res);
        const { from, to, layout } = req.body || {};
        try {
            const cameras = readCameras();
            const slots = currentLayout(cameras);
            if (layout !== layoutVersion(slots)) return conflict(res, '다른 곳에서 배치가 바뀌었습니다.');
            const next = moveSlot(slots, from, to);
            if (!next) return bad(res, '옮길 수 없는 칸입니다.');
            saveLayout(layoutPath, next);
            console.log(`[LAYOUT] ${from + 1}번 칸 → ${to + 1}번 칸`);
            res.json({ status: 'success', ...channelList(cameras, next) });
        } catch (error) {
            console.error('Layout save failed:', error.message);
            res.status(500).json({ status: 'error', message: '배치 저장에 실패했습니다.' });
        }
    });

    app.get('/api/get-channel-list', authMiddleware, (req, res) => {
        try {
            res.json({ status: 'success', ...channelList(readCameras()) });
        } catch (error) {
            console.error('Channel list failed:', error.message);
            res.status(500).json({ status: 'error', message: 'cctv.txt 를 읽을 수 없습니다.' });
        }
    });

    app.get('/api/cameras', authMiddleware, (req, res) => {
        try {
            const cameras = readCameras().map(c => {
                const p = parseRtspUrl(c.url) || { host: '', port: null, path: '', username: '' };
                return { index: c.index, hash: c.hash, name: c.name, host: p.host, port: p.port, path: p.path, username: p.username };
            });
            res.json({ status: 'success', cameras });
        } catch (error) {
            console.error('Camera list failed:', error.message);
            res.status(500).json({ status: 'error', message: 'cctv.txt 를 읽을 수 없습니다.' });
        }
    });

    app.post('/api/cameras', authMiddleware, async (req, res) => {
        const { url, name, subUrl } = req.body || {};
        const error = urlError(url) || subUrlError(subUrl, url) || textError([['카메라 이름', name]]);
        if (error) return bad(res, error);
        const sub = subUrl || null;
        const done = await commit(req, res, { type: 'append', url, name: name || '', subUrl: sub }, () => streams.add(url, sub));
        if (done) res.json({ status: 'success', index: done.index, applied: done.applied });
    });

    /** 수정 대상 확인: 순번과 줄 해시가 모두 맞아야 한다 */
    function findTarget(req, res) {
        const index = Number(req.params.index);
        const { hash } = req.body || {};
        const target = Number.isInteger(index) ? readCameras()[index] : undefined;
        if (!target || typeof hash !== 'string' || target.hash !== hash) {
            conflict(res, '목록이 바뀌었습니다. 화면을 다시 열어 주세요.');
            return null;
        }
        return { index, hash, target };
    }

    async function saveNewUrl(req, res, { index, hash, name, oldUrl, url, subUrl }) {
        const done = await commit(req, res, { type: 'update', index, hash, url, name, subUrl }, () => streams.restart(oldUrl, url, subUrl));
        if (done) res.json({ status: 'saved', applied: done.applied });
    }

    app.post('/api/cameras/:index/edit', authMiddleware, async (req, res) => {
        const { name, username, password } = req.body || {};
        const error = textError([['카메라 이름', name], ['아이디', username], ['비밀번호', password]]);
        if (error) return bad(res, error);
        // 아이디는 RTSP Digest 헤더에 그대로 들어가므로 줄바꿈/따옴표/제어문자를 거부한다
        if (typeof username === 'string' && /[\x00-\x1f\x7f"]/.test(username)) return bad(res, '아이디에 사용할 수 없는 문자(따옴표, 줄바꿈 등)가 있습니다.');

        const found = findTarget(req, res);
        if (!found) return;
        const { index, hash, target } = found;
        const parts = parseRtspUrl(target.url);
        if (!parts || !isPrivateIPv4(parts.host)) return bad(res, '이 카메라의 주소 형식을 읽을 수 없습니다. 삭제한 뒤 다시 추가해 주세요.');

        const newUser = typeof username === 'string' ? username : parts.username;
        // 이름만 바꾸면 카메라에 접속하지 않고, 영상도 끊지 않는다
        if (newUser === parts.username && !password) {
            const done = await commit(req, res, { type: 'update', index, hash, name: name ?? target.name }, async () => {});
            if (done) res.json({ status: 'saved', applied: true });
            return;
        }

        if (!probeLimiter.allow(keyOf(req))) return tooMany(res);
        if (probingIps.has(parts.host)) return conflict(res, '같은 카메라에 대한 탐색이 이미 진행 중입니다. 잠시 후 다시 시도하세요.');
        probingIps.add(parts.host);
        let result;
        try {
            // 비밀번호를 비워 두면 기존 비밀번호를 쓴다 (빈 비밀번호로 시도해 실패 횟수를 날리지 않도록)
            // 이 수정 요청 안의 두 탐색(기존 경로 확인 → 전체 탐색)은 같은 예산을 쓴다 (합쳐서 실패 최대 2회)
            const base = { host: parts.host, username: newUser, password: password || parts.password, vendorHint: '', budget: newBudget(), settings: settings() };
            // 지금 쓰는 포트/경로로 먼저 한 번만 확인하고, 경로를 못 찾았을 때만 전체 탐색한다
            result = await doFind({ ...base, port: parts.port, path: parts.path });
            if (result.status === 'path_not_found') result = await doFind(base);
        } catch (error) {
            console.error('Camera edit probe failed:', error.message);
            return res.status(500).json({ status: 'error', message: '주소 찾기 중 오류가 발생했습니다.' });
        } finally {
            probingIps.delete(parts.host);
        }

        if (result.status !== 'found') {
            const { candidates, ...rest } = result;
            return res.json(rest);
        }
        // 이 카메라(같은 IP)의 주소만 받아들인다
        const okCands = (result.candidates || []).filter(c => parseRtspUrl(c.url)?.host === parts.host && !urlError(c.url));
        const urls = okCands.map(c => c.url);
        const labels = okCands.map(c => c.label);
        // 서브 주소: 찾은 후보에 있으면 그것을, 없으면 기존 서브 주소의 계정만 새 계정으로 바꾼다
        const newPass = password || parts.password;
        const subs = okCands.map(c => (c.subUrl && !subUrlError(c.subUrl, c.url) ? c.subUrl
            : target.subUrl && parseRtspUrl(target.subUrl)?.host === parts.host ? withCredentials(target.subUrl, { username: newUser, password: newPass }) : null));
        if (urls.length === 0) return bad(res, '찾은 주소가 이 카메라와 맞지 않습니다.');
        const newName = name ?? target.name;
        if (urls.length === 1) return saveNewUrl(req, res, { index, hash, name: newName, oldUrl: target.url, url: urls[0], subUrl: subs[0] });

        // 여러 스트림이 나오면 사용자가 고른다. 주소(비밀번호 포함)는 세션에만 두고 화면에는 가린 주소만 보낸다
        req.session.pendingEdit = { index, hash, name: newName, oldUrl: target.url, urls, subs };
        const preselect = Math.max(0, urls.findIndex(u => parseRtspUrl(u).path === parts.path && parseRtspUrl(u).port === parts.port));
        res.json({ status: 'choose', preselect, candidates: urls.map((u, i) => ({ label: labels[i] || `스트림 ${i + 1}`, maskedUrl: maskedUrl(u) })) });
    });

    app.post('/api/cameras/:index/edit/confirm', authMiddleware, async (req, res) => {
        const pending = req.session && req.session.pendingEdit;
        const { hash, choice } = req.body || {};
        const index = Number(req.params.index);
        if (!pending || pending.index !== index || pending.hash !== hash || !Number.isInteger(choice) || !pending.urls[choice]) {
            return conflict(res, '목록이 바뀌었습니다. 화면을 다시 열어 주세요.');
        }
        delete req.session.pendingEdit;
        return saveNewUrl(req, res, { index, hash, name: pending.name, oldUrl: pending.oldUrl, url: pending.urls[choice], subUrl: (pending.subs || [])[choice] || null });
    });

    app.delete('/api/cameras/:index', authMiddleware, async (req, res) => {
        const found = findTarget(req, res);
        if (!found) return;
        const { index, hash, target } = found;
        const done = await commit(req, res, { type: 'remove', index, hash }, () => streams.remove(target.url));
        if (done) res.json({ status: 'success', applied: done.applied });
    });
}

module.exports = { registerCameraRoutes };
