'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPasswordStore } = require('../settings/password-store');

function tempConfig(obj = { password: 'old-pass' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctvgo-config-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf8');
    return configPath;
}

test('get: config.json 의 비밀번호를 읽고, 파일이 없으면 null', () => {
    const configPath = tempConfig();
    assert.equal(createPasswordStore(configPath).get(), 'old-pass');
    assert.equal(createPasswordStore(configPath + '.none').get(), null);
});

test('tag: 비밀번호가 바뀌면 값이 바뀌고, 비밀번호 자체를 담지 않는다', () => {
    const configPath = tempConfig();
    const store = createPasswordStore(configPath);
    const before = store.tag();
    assert.ok(before && !before.includes('old-pass'));
    assert.equal(store.tag(), before);
    store.change('old-pass', 'new-pass');
    assert.notEqual(store.tag(), before);
});

test('tag: config.json 을 직접 고쳐도 반영된다 (복구 경로)', () => {
    const configPath = tempConfig();
    const store = createPasswordStore(configPath);
    const before = store.tag();
    fs.writeFileSync(configPath, JSON.stringify({ password: 'hand-edited-longer' }), 'utf8');
    assert.equal(store.get(), 'hand-edited-longer');
    assert.notEqual(store.tag(), before);
});

test('change: 현재 비밀번호가 틀리면 바꾸지 않는다', () => {
    const configPath = tempConfig();
    const store = createPasswordStore(configPath);
    const r = store.change('wrong', 'new-pass');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong_current');
    assert.equal(store.get(), 'old-pass');
});

test('change: 새 비밀번호 길이/형식 검증', () => {
    const store = createPasswordStore(tempConfig());
    for (const bad of ['abc', 'x'.repeat(65), 'ab\ncd', 1234, undefined]) {
        const r = store.change('old-pass', bad);
        assert.equal(r.ok, false, JSON.stringify(bad));
        assert.equal(r.reason, 'invalid_new');
    }
    assert.equal(store.get(), 'old-pass');
});

test('change: 다른 설정 키는 보존하고, 임시 파일을 남기지 않는다', () => {
    const configPath = tempConfig({ password: 'old-pass', other: 1 });
    const store = createPasswordStore(configPath);
    assert.equal(store.change('old-pass', 'new-pass').ok, true);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved, { password: 'new-pass', other: 1 });
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['config.json']);
});
