'use strict';
const crypto = require('crypto');
const fs = require('fs');

/**
 * cctv.txt 읽기/쓰기.
 * 카메라 줄 형식: rtsp://아이디:비밀번호@IP:포트/경로, 이름
 * - '#' 주석과 빈 줄은 그대로 보존한다.
 * - 아이디/비밀번호는 URL 인코딩한다 (cctv.txt 안내의 특수문자 코드표와 동일: ! -> %21, * -> %2A ...).
 */

function encodeCred(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildRtspUrl({ username, password, host, port, path }) {
    const auth = username ? `${encodeCred(username)}:${encodeCred(password || '')}@` : '';
    const p = path ? (path.startsWith('/') ? path : '/' + path) : '';
    return `rtsp://${auth}${host}:${port}${p}`;
}

function detectEol(text) {
    return text.includes('\n') && !text.includes('\r\n') ? '\n' : '\r\n';
}

function isCameraLine(line) {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
}

function sanitizeName(name, fallback) {
    const clean = String(name || '').replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean || fallback;
}

function lineHash(raw) {
    return crypto.createHash('sha256').update(raw.trim(), 'utf8').digest('hex').slice(0, 16);
}

/** 서버/영상 시작/목록 API 가 모두 이 해석을 쓴다 (줄 순서가 영상 번호와 맞아야 하므로 해석 규칙은 여기 하나뿐) */
function parseCameras(text) {
    return text
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter(isCameraLine)
        .map((line, index) => {
            const i = line.indexOf(',');
            const url = (i >= 0 ? line.slice(0, i) : line).trim();
            const name = i >= 0 ? line.slice(i + 1).trim() : '';
            return { index, url, name, raw: line.trim(), hash: lineHash(line) };
        });
}

function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
}

/** rtsp://[아이디[:비밀번호]@]호스트[:포트][/경로[?쿼리]] 를 나눈다. 아이디/비밀번호는 인코딩을 풀어서 돌려준다 */
function parseRtspUrl(url) {
    const m = /^rtsp:\/\/([^/?]*)(.*)$/i.exec(String(url || '').trim());
    if (!m) return null;
    const authority = m[1];
    const at = authority.lastIndexOf('@');
    const userinfo = at >= 0 ? authority.slice(0, at) : '';
    const hostport = at >= 0 ? authority.slice(at + 1) : authority;
    const hp = /^([^:]+)(?::(\d{1,5}))?$/.exec(hostport);
    if (!hp) return null;
    const colon = userinfo.indexOf(':');
    const username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const password = colon >= 0 ? userinfo.slice(colon + 1) : '';
    const rest = m[2] || '';
    return {
        host: hp[1],
        port: hp[2] ? Number(hp[2]) : 554,
        path: rest.startsWith('/') ? rest : '/' + rest,
        username: safeDecode(username),
        password: safeDecode(password),
    };
}

/** 같은 카메라 영상인지 (호스트/포트/경로 비교, 계정은 무시) */
function sameStream(a, b) {
    const x = parseRtspUrl(a);
    const y = parseRtspUrl(b);
    return !!x && !!y && x.host === y.host && x.port === y.port && x.path === y.path;
}

function editError(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * text 에 추가/수정/삭제를 적용한 새 text 를 반환한다 (파일 접근 없음)
 * op: { type: 'append', url, name } | { type: 'update', index, hash, url?, name? } | { type: 'remove', index, hash }
 * 수정/삭제는 순번과 줄 해시가 모두 맞아야 한다 (다른 창에서 목록이 바뀌었으면 CONFLICT)
 */
function applyEdit(text, op) {
    const eol = detectEol(text);
    const cameras = parseCameras(text);

    if (op.type === 'append') {
        if (cameras.some(c => sameStream(c.url, op.url))) throw editError('DUPLICATE', '이미 등록된 카메라입니다.');
        const newLine = `${op.url}, ${sanitizeName(op.name, `카메라 ${cameras.length + 1}`)}`;
        const sep = text.length === 0 || /\n$/.test(text) ? '' : eol;
        return { text: text + sep + newLine + eol, index: cameras.length };
    }

    const target = Number.isInteger(op.index) ? cameras[op.index] : undefined;
    if (!target || target.hash !== op.hash) throw editError('CONFLICT', '목록이 바뀌었습니다. 화면을 다시 열어 주세요.');

    const lines = text.split(/\r?\n/);
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
        if (isCameraLine(lines[i]) && ++seen === op.index) {
            if (op.type === 'remove') {
                lines.splice(i, 1);
            } else {
                const url = op.url || target.url;
                const name = op.name !== undefined ? op.name : target.name;
                lines[i] = `${url}, ${sanitizeName(name, `카메라 ${op.index + 1}`)}`;
            }
            break;
        }
    }
    return { text: lines.join(eol), index: op.index };
}

/** 백업(.bak) 후 임시 파일에 쓰고 rename 한다. 실패하면 원본은 그대로 남는다. */
function saveCameras(filePath, op) {
    const exists = fs.existsSync(filePath);
    const text = exists ? fs.readFileSync(filePath, 'utf8') : '';
    const result = applyEdit(text, op);

    let backup = null;
    if (exists) {
        backup = filePath + '.bak';
        fs.copyFileSync(filePath, backup);
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, result.text, 'utf8');
    fs.renameSync(tmp, filePath);
    return { index: result.index, backup };
}

module.exports = { encodeCred, buildRtspUrl, parseCameras, parseRtspUrl, sameStream, applyEdit, saveCameras };
