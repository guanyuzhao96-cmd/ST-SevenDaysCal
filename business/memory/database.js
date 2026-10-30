import { isDatabaseMemoEntry, mergeRecallTags } from '../../runtime/refactor-adapters.js';
import { diagnosticMessage } from '../../api/diagnostics.js';

const EMPTY_COUNTS = Object.freeze({ entries: 0, matched: 0, usable: 0, selected: 0 });

// CWB archives belong to a character avatar, not to a chat or a book name.
export function cwbOwner(context) {
    const chars = context?.characters || [];
    let char = context?.characterId != null && context.characterId !== '' ? chars[context.characterId] : null;
    if (!char?.avatar) {
        const group = (context?.groups || []).find(g => String(g.id) === String(context?.groupId));
        const members = [...new Set(group?.members || [])];
        if (members.length === 1) char = Object.values(chars).find(c => c?.avatar === members[0]);
    }
    return typeof char?.avatar === 'string' && char.avatar.trim() ? `CWB:角色卡:${encodeURIComponent(char.avatar)}` : '';
}

export function cwbMemoryType(entry, owner) {
    const keys = [entry?.key, entry?.keys, entry?.strategy?.keys].flatMap(v => Array.isArray(v) ? v : []).map(String);
    const owners = [...new Set(keys.filter(k => k.startsWith('CWB:角色卡:')))];
    if (!owner || owners.length !== 1 || owners[0] !== owner) return '';
    if (keys.includes('CWB:故事时间线')) return '故事时间线';
    if (keys.includes('CWB:角色关系汇总')) return '角色关系';
    return '';
}

export function normalizeDatabaseWorldbookName(value) {
    return String(value ?? '').trim();
}

// Resolve once at the start of a read. An explicit choice always wins, including
// when that book is later missing: falling back to the primary book could inject
// history from a different archive without the user noticing.
export function resolveDatabaseWorldbookTarget({ selectedName = '', primaryName = '' } = {}) {
    const selected = normalizeDatabaseWorldbookName(selectedName);
    if (selected) return { bookName: selected, targetMode: 'explicit' };
    return { bookName: normalizeDatabaseWorldbookName(primaryName), targetMode: 'primary' };
}

function resultFor(status, target, counts = {}, extra = {}) {
    return {
        status,
        text: '',
        ...EMPTY_COUNTS,
        ...counts,
        bookName: normalizeDatabaseWorldbookName(target?.bookName),
        targetMode: target?.targetMode === 'explicit' ? 'explicit' : 'primary',
        ...extra,
    };
}

export async function readDatabaseMemory({
    target,
    getWorldbook,
    selectSlices,
    query = '',
    limit = 20,
    owner = '',
} = {}) {
    // Copy scalar values before the first await so a settings/chat change cannot
    // retarget this in-flight read.
    const frozenTarget = {
        bookName: normalizeDatabaseWorldbookName(target?.bookName),
        targetMode: target?.targetMode === 'explicit' ? 'explicit' : 'primary',
    };
    if (typeof getWorldbook !== 'function') return resultFor('api-unavailable', frozenTarget);
    if (!frozenTarget.bookName) return resultFor('worldbook-unavailable', frozenTarget);

    let entries;
    try {
        entries = await getWorldbook(frozenTarget.bookName);
    } catch (error) {
        return resultFor('worldbook-read-failed', frozenTarget, {}, { error });
    }
    if (!Array.isArray(entries)) return resultFor('invalid-response', frozenTarget);

    const cwbEntries = entries.map(entry => ({ entry, type: cwbMemoryType(entry, owner) })).filter(item => item.type);
    const matchedEntries = entries.filter(isDatabaseMemoEntry);
    if (!matchedEntries.length && !cwbEntries.length) {
        return resultFor('no-match', frozenTarget, { entries: entries.length });
    }
    const memories = matchedEntries.map((entry, index) => ({
        text: String(entry?.content || '').trim(),
        tags: mergeRecallTags(entry),
        batch: index,
        slice: 0,
        time: '',
    }));
    const nonEmpty = memories.filter(item => item.text);
    const cwb = cwbEntries.filter(item => String(item.entry?.content || '').trim());
    if (!nonEmpty.length && !cwb.length) {
        return resultFor('empty-content', frozenTarget, {
            entries: entries.length,
            matched: matchedEntries.length,
        });
    }

    const picked = typeof selectSlices === 'function'
        ? selectSlices(nonEmpty, String(query ?? ''), limit)
        : nonEmpty.slice(0, limit);
    const selected = Array.isArray(picked) ? picked : [];
    const text = [...cwb.map(item => `【角色档案：${item.type}】\n${String(item.entry.content).trim()}`),
        ...selected.map(item => String(item?.text || '').trim()).filter(Boolean)].join('\n\n');
    return {
        ...resultFor(text ? 'ready' : 'empty-content', frozenTarget, {
            entries: entries.length,
            matched: matchedEntries.length + cwbEntries.length,
            usable: nonEmpty.length + cwb.length,
            selected: selected.length + cwb.length,
        }),
        text,
    };
}

export function createDatabaseMemoryAccess({
    captureTarget,
    captureReader,
    buildQuery,
    getLimit,
    selectSlices,
    captureOwner,
} = {}) {
    async function result(opts = {}) {
        // Target and reader are both captured synchronously. The same path serves
        // settings diagnostics, generation preflight and the final prompt injection.
        const target = resolveDatabaseWorldbookTarget(captureTarget?.() || {});
        const reader = captureReader?.();
        const owner = captureOwner?.() || '';
        try {
            return await readDatabaseMemory({
                target,
                getWorldbook: reader,
                selectSlices,
                query: buildQuery?.(opts.query) ?? opts.query ?? '',
                limit: getLimit?.() ?? 20,
                owner,
            });
        } catch (error) {
            return resultFor('processing-failed', target, {}, { error });
        }
    }
    return {
        result,
        async text(opts = {}) {
            return (await result(opts)).text;
        },
    };
}

export function databaseMemoryDiagnostic(result) {
    const bookName = normalizeDatabaseWorldbookName(result?.bookName);
    const book = bookName ? `世界书「${bookName}」` : '目标世界书';
    const knownReason = /^(not found|unavailable|permission denied)$/i.test(String(result?.error?.message || '').trim())
        ? `：${String(result.error.message).trim()}` : '';
    switch (result?.status) {
        case 'api-unavailable':
            return '检测不到 TavernHelper 世界书读取接口';
        case 'worldbook-unavailable':
            return result?.targetMode === 'explicit' ? `${book}当前不可用` : '未取得角色主世界书';
        case 'worldbook-read-failed':
            return `${book}读取失败${knownReason || `：${diagnosticMessage(result?.error, { phase: 'request' })}`}`;
        case 'processing-failed':
            return `${book}数据库纪要处理失败：${diagnosticMessage(result?.error, { phase: 'parse' })}`;
        case 'invalid-response':
            return `${book}返回结构异常`;
        case 'no-match':
            return `${book}中没有匹配到数据库纪要`;
        case 'empty-content':
            return `${book}匹配到数据库纪要，但正文为空（匹配 ${result?.matched || 0} 条，可用 ${result?.usable || 0} 条）`;
        case 'ready':
            return `数据库记忆已就绪（${book}；匹配 ${result?.matched || 0} 条，可用 ${result?.usable || 0} 条，本次注入 ${result?.selected || 0} 条）`;
        default:
            return '数据库读取状态未知';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderDatabaseWorldbookOptions(names, selectedName = '') {
    const selected = normalizeDatabaseWorldbookName(selectedName);
    const available = [...new Set((Array.isArray(names) ? names : [])
        .filter(name => typeof name === 'string')
        .map(normalizeDatabaseWorldbookName)
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh'));
    const rows = [
        `<option value=""${selected ? '' : ' selected'}>跟随角色主世界书（默认）</option>`,
    ];
    if (selected && !available.includes(selected)) {
        rows.push(`<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(selected)}（当前不可用）</option>`);
    }
    for (const name of available) {
        rows.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    return rows.join('');
}

export function databaseMemoryUiIdentity({ chatId, characterId, characterKey, selectedName } = {}) {
    return {
        chatId: String(chatId ?? ''),
        characterId: String(characterId ?? ''),
        characterKey: String(characterKey ?? ''),
        selectedName: normalizeDatabaseWorldbookName(selectedName),
    };
}

export function sameDatabaseMemoryUiIdentity(left, right) {
    return !!left && !!right
        && left.chatId === right.chatId
        && left.characterId === right.characterId
        && left.characterKey === right.characterKey
        && left.selectedName === right.selectedName;
}
