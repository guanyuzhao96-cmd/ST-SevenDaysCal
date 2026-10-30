import test from 'node:test';
import assert from 'node:assert/strict';
import { cwbOwner, readDatabaseMemory } from '../business/memory/database.js';

test('reads both CWB records for the selected card while excluding other archives', async () => {
    const owner = cwbOwner({ characters: [{ avatar: '角色 A.png' }], characterId: 0 });
    const entries = [
        { key: ['CWB:故事时间线', owner], content: '[时间线.0]: 2025-09-01｜见面' },
        { strategy: { keys: ['CWB:角色关系汇总', owner] }, content: '甲 ↔ 乙：朋友' },
        { key: ['CWB:故事时间线', 'CWB:角色卡:other.png'], content: '其他卡秘密' },
        { key: ['CWB:故事时间线'], content: '无归属' },
        { name: '总结条目1', content: '数据库摘要' },
    ];
    const result = await readDatabaseMemory({ target: { bookName: '档案' }, getWorldbook: async () => entries, owner, limit: 1 });
    assert.equal(result.status, 'ready');
    assert.match(result.text, /见面/); assert.match(result.text, /朋友/); assert.match(result.text, /数据库摘要/);
    assert.doesNotMatch(result.text, /其他卡秘密|无归属/);
    assert.equal(result.selected, 3);
});

test('does not read CWB records when ownership is unknown or ambiguous', async () => {
    const result = await readDatabaseMemory({ target: { bookName: '档案' }, getWorldbook: async () => [{ key: ['CWB:故事时间线', 'CWB:角色卡:a', 'CWB:角色卡:b'], content: 'x' }], owner: 'CWB:角色卡:a' });
    assert.equal(result.status, 'no-match');
    assert.equal(cwbOwner({}), '');
});
