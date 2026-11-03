'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { parseRtspUrl } = require('./cctv-file');

/**
 * 영상 화면 칸 배치 (어느 카메라가 몇 번 칸에 있는지). cctv.txt 옆 layout.json 에 저장한다.
 * - 카메라는 주소(호스트:포트/경로)로 구분한다. 비밀번호는 넣지 않고, 비밀번호가 바뀌어도 자리를 지킨다.
 * - 칸 수 규칙은 화면과 같다: 2줄, 최소 2열, 열 수 = 카메라 수 / 2 올림. 칸 번호는 왼쪽 위부터 줄 순서.
 * - 저장된 자리가 없거나(새 카메라) 칸이 줄어 자리가 없어진 카메라는 등록 순서대로 앞쪽 첫 빈 칸에 넣는다.
 * - 읽을 때는 파일을 쓰지 않는다. 옮길 때만 지금 보이는 배치 전체를 저장한다.
 */

const ROWS = 2;
const MIN_COLUMNS = 2;

function gridColumns(count) {
    return Math.max(MIN_COLUMNS, Math.ceil(count / ROWS));
}

function gridSlots(count) {
    return ROWS * gridColumns(count);
}

/** cctv.txt 카메라 주소 목록 → 배치용 키 목록 (같은 주소가 여러 줄이면 #2, #3 을 붙인다) */
function cameraKeys(urls) {
    const seen = new Map();
    return urls.map(url => {
        const p = parseRtspUrl(url);
        const base = p ? `${p.host.toLowerCase()}:${p.port}${p.path}` : String(url).replace(/^rtsp:\/\/[^@/]*@/i, '');
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return n === 1 ? base : `${base}#${n}`;
    });
}

/**
 * 저장된 배치 { columns, slots }(slots: 키 또는 null)와 지금 카메라 키 목록으로 실제 배치를 만든다.
 * 열 수가 바뀌어도 줄/열 위치를 지킨다 (칸 번호만 쓰면 3열→2열에서 아래 줄 카메라가 옆으로 밀린다)
 */
function resolveLayout(saved, keys) {
    const columns = gridColumns(keys.length);
    const slots = new Array(ROWS * columns).fill(null);
    const present = new Set(keys);
    const placed = new Set();
    const savedSlots = saved && Array.isArray(saved.slots) ? saved.slots : [];
    const savedColumns = saved && Number.isInteger(saved.columns) && saved.columns > 0 ? saved.columns : columns;
    savedSlots.forEach((key, i) => {
        const row = Math.floor(i / savedColumns);
        const col = i % savedColumns;
        if (row >= ROWS || col >= columns) return;   // 없어진 칸: 아래에서 앞쪽 빈 칸으로
        const at = row * columns + col;
        if (key && present.has(key) && !placed.has(key) && slots[at] === null) {
            slots[at] = key;
            placed.add(key);
        }
    });
    for (const key of keys) {
        if (placed.has(key)) continue;
        const empty = slots.indexOf(null);
        slots[empty] = key;   // 칸 수가 카메라 수 이상이라 항상 빈 칸이 있다
        placed.add(key);
    }
    return slots;
}

/** from 칸의 카메라를 to 칸으로: 빈 칸이면 이동, 카메라가 있으면 맞바꿈. 잘못된 요청이면 null */
function moveSlot(slots, from, to) {
    const ok = n => Number.isInteger(n) && n >= 0 && n < slots.length;
    if (!ok(from) || !ok(to) || from === to || !slots[from]) return null;
    const next = slots.slice();
    next[to] = slots[from];
    next[from] = slots[to];
    return next;
}

/** 화면이 본 배치와 서버 배치가 같은지 확인하는 값 (다른 기기에서 바꿨으면 달라진다) */
function layoutVersion(slots) {
    return crypto.createHash('sha256').update(JSON.stringify(slots), 'utf8').digest('hex').slice(0, 12);
}

/** { columns, slots } 또는 null */
function loadLayout(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const slots = data && data.slots;
        if (!Array.isArray(slots) || !slots.every(s => s === null || typeof s === 'string')) return null;
        if (!Number.isInteger(data.columns) || data.columns < 1) return null;
        return { columns: data.columns, slots };
    } catch (e) {
        return null;   // 없거나 깨졌으면 등록 순서대로
    }
}

/** 임시 파일에 쓰고 rename 한다 (쓰다 실패해도 기존 배치는 그대로) */
function saveLayout(filePath, slots) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ columns: slots.length / ROWS, slots }, null, 1), 'utf8');
    fs.renameSync(tmp, filePath);
}

module.exports = { ROWS, gridColumns, gridSlots, cameraKeys, resolveLayout, moveSlot, layoutVersion, loadLayout, saveLayout };
