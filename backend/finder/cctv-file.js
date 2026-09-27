'use strict';
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

function parseCameras(text) {
    return text
        .split(/\r?\n/)
        .filter(isCameraLine)
        .map((line, index) => {
            const i = line.indexOf(',');
            const url = (i >= 0 ? line.slice(0, i) : line).trim();
            const name = i >= 0 ? line.slice(i + 1).trim() : '';
            return { index, url, name };
        });
}

/** text에 카메라 줄을 추가/교체한 새 text를 반환한다 (파일 접근 없음) */
function applyCameraLine(text, { url, name, mode = 'append', replaceIndex }) {
    const eol = detectEol(text);
    const cameras = parseCameras(text);

    if (mode === 'replace') {
        if (!Number.isInteger(replaceIndex) || replaceIndex < 0 || replaceIndex >= cameras.length) {
            throw new Error('교체할 카메라를 찾을 수 없습니다.');
        }
        const newLine = `${url}, ${sanitizeName(name, `카메라 ${replaceIndex + 1}`)}`;
        const lines = text.split(/\r?\n/);
        let seen = -1;
        for (let i = 0; i < lines.length; i++) {
            if (isCameraLine(lines[i]) && ++seen === replaceIndex) {
                lines[i] = newLine;
                break;
            }
        }
        return { text: lines.join(eol), index: replaceIndex };
    }

    const newLine = `${url}, ${sanitizeName(name, `카메라 ${cameras.length + 1}`)}`;
    const sep = text.length === 0 || /\n$/.test(text) ? '' : eol;
    return { text: text + sep + newLine + eol, index: cameras.length };
}

/** 백업(.bak) 후 임시 파일에 쓰고 rename 한다. 실패하면 원본은 그대로 남는다. */
function saveCameraLine(filePath, opts) {
    const exists = fs.existsSync(filePath);
    const text = exists ? fs.readFileSync(filePath, 'utf8') : '';
    const result = applyCameraLine(text, opts);

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

module.exports = { encodeCred, buildRtspUrl, parseCameras, applyCameraLine, saveCameraLine };
