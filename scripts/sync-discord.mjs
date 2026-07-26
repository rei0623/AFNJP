#!/usr/bin/env node
/**
 * AFNJP ─ サイト用データ同期スクリプト
 *
 * Discord の Bot トークンでサーバーの状態を取得し、次の3つを更新する。
 *   1. channels.json … カテゴリ別のチャンネル一覧と総数
 *   2. posts.json    … 各フォーラムの最新投稿（記事）
 *   3. assets/posts/ … 記事のカバー画像（DiscordのCDN URLは期限切れになるため取り込む）
 *
 * Bot に必要な権限: View Channels / Read Message History
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN … Bot トークン
 *   DISCORD_GUILD_ID  … 省略時は AFNJP のギルドID
 *
 * 使い方:
 *   DISCORD_BOT_TOKEN=xxxxx node scripts/sync-discord.mjs
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHANNELS_OUT = resolve(ROOT, 'channels.json');
const POSTS_OUT = resolve(ROOT, 'posts.json');
const COVER_DIR = resolve(ROOT, 'assets', 'posts');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1415350002255007784';

/** サイトに出さないカテゴリ（運営専用など） */
const PRIVATE_CATEGORIES = [/運営/];
/** 記事フィードに載せるのは、この一覧に入っていないカテゴリのフォーラム */
const NON_ARTICLE_CATEGORIES = [/運営/, /Welcome/i, /コミュニティ/, /デイリーレポート/];

const MAX_POSTS = 12;

const TEXTISH = new Set([0, 5, 15, 16]); // text / announcement / forum / media
const CATEGORY_TYPE = 4;
const FORUM_TYPES = new Set([15, 16]);

if (!TOKEN) {
    console.error('✗ DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/** チャンネル名：絵文字プレフィックスと区切り記号を落として素の名前にする（例「💻｜cursor」→「cursor」） */
function clean(name = '') {
    return name
        .replace(EMOJI, '')
        .replace(/[｜|・:：]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-_\s]+|[-_\s]+$/g, '');
}

/** カテゴリ名：「====== Google ======」のような飾りを落とす */
function cleanCategory(name = '') {
    return clean(name).replace(/^[=＝\-—\s]+|[=＝\-—\s]+$/g, '').trim();
}

/** 記事タイトル：先頭の絵文字だけを落とし、「・」などの句読点はそのまま残す */
function cleanTitle(name = '') {
    return name
        .replace(EMOJI, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function api(path) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'AFNJP-site-sync/2.0' },
    });
    if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 2);
        console.warn(`  … レート制限。${retry}s 待機`);
        await new Promise(r => setTimeout(r, retry * 1000 + 250));
        return api(path);
    }
    if (!res.ok) throw new Error(`Discord API ${res.status} ${res.statusText} — ${await res.text()}`);
    return res.json();
}

const isPrivate = name => PRIVATE_CATEGORIES.some(re => re.test(name));
const isArticleCat = name => !NON_ARTICLE_CATEGORIES.some(re => re.test(name));

/* ═══════════ 1. チャンネル一覧 ═══════════ */

const prevChannels = await readFile(CHANNELS_OUT, 'utf8').then(JSON.parse).catch(() => null);
const all = await api(`/guilds/${GUILD_ID}/channels`);

const catById = new Map(
    all.filter(c => c.type === CATEGORY_TYPE)
        .sort((a, b) => a.position - b.position)
        .map(c => [c.id, { name: cleanCategory(c.name) || c.name, channels: [], raw: [] }])
);
const orphan = { name: 'その他', channels: [], raw: [] };

for (const c of all.filter(c => TEXTISH.has(c.type)).sort((a, b) => a.position - b.position)) {
    const g = catById.get(c.parent_id) ?? orphan;
    const name = clean(c.name);
    if (!name) continue;
    g.channels.push(name);
    g.raw.push(c);
}

const publicGroups = [...catById.values(), orphan]
    .filter(g => g.channels.length && !isPrivate(g.name));

const channelCount = publicGroups.reduce((n, g) => n + g.channels.length, 0);

await writeFile(CHANNELS_OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'discord-api',
    guild_id: GUILD_ID,
    count: channelCount,
    previous_count: prevChannels?.count ?? channelCount,
    groups: publicGroups.map(g => ({ category: g.name, channels: g.channels })),
}, null, 2) + '\n', 'utf8');

const dCh = channelCount - (prevChannels?.count ?? channelCount);
console.log(`✓ channels.json: ${channelCount} channels / ${publicGroups.length} categories` +
    (dCh ? ` (前回比 ${dCh > 0 ? '+' : ''}${dCh})` : ' (変化なし)'));

/* ═══════════ 2. 最新の記事（フォーラム投稿） ═══════════ */

// 記事チャンネル（公開カテゴリのフォーラム）を集める
const forumIds = new Map(); // channelId -> {channel, category}
for (const g of publicGroups) {
    if (!isArticleCat(g.name)) continue;
    for (const c of g.raw) {
        if (FORUM_TYPES.has(c.type)) forumIds.set(c.id, { channel: clean(c.name), category: g.name });
    }
}

// アクティブスレッド（＝フォーラムの投稿）を一括取得
const active = await api(`/guilds/${GUILD_ID}/threads/active`);
const threads = (active.threads || [])
    .filter(t => forumIds.has(t.parent_id))
    .map(t => ({
        t,
        created: new Date(t.thread_metadata?.create_timestamp || t.id && snowflakeToDate(t.id)).getTime(),
    }))
    .sort((a, b) => b.created - a.created)
    .slice(0, MAX_POSTS);

function snowflakeToDate(id) {
    return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}

/** 本文から先頭の段落（リード）を抜き、Markdown記法を落とす */
function excerptOf(content = '') {
    const body = content
        .split(/\n#{1,3}\s|\n\*\*参考文献\*\*|\n参考文献/)[0]
        .replace(/^#+\s.*$/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_`>]/g, '')
        .trim();
    const first = body.split(/\n\s*\n/).find(p => p.trim().length > 20) || body;
    const s = first.replace(/\s+/g, ' ').trim();
    return s.length > 130 ? s.slice(0, 128) + '…' : s;
}

/** 本文・埋め込みから一次情報のURLを拾う */
function sourceOf(msg) {
    const fromEmbed = msg.embeds?.find(e => e.url)?.url;
    const fromText = (msg.content || '').match(/https?:\/\/[^\s<>)]+/g)?.find(u => !u.includes('discord'));
    const url = fromEmbed || fromText || null;
    if (!url) return { source_url: null, source_label: null };
    let label = null;
    try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { }
    return { source_url: url, source_label: label };
}

function coverUrlOf(msg) {
    for (const e of msg.embeds || []) {
        if (e.image?.url) return e.image.url;
        if (e.thumbnail?.url) return e.thumbnail.url;
    }
    const att = (msg.attachments || []).find(a => (a.content_type || '').startsWith('image/'));
    return att?.url || null;
}

await mkdir(COVER_DIR, { recursive: true });

const posts = [];
const keep = new Set();

for (const { t, created } of threads) {
    const meta = forumIds.get(t.parent_id);
    let msg = null;
    try {
        // フォーラム投稿の最初のメッセージは、スレッドIDと同じIDを持つ
        msg = await api(`/channels/${t.id}/messages/${t.id}`);
    } catch {
        console.warn(`  … 「${t.name}」の本文を取得できませんでした`);
    }

    const { source_url, source_label } = msg ? sourceOf(msg) : { source_url: null, source_label: null };

    // カバー画像を取り込む（Discord の CDN URL は期限切れになるため）
    let cover = null;
    const remote = msg && coverUrlOf(msg);
    if (remote) {
        try {
            const r = await fetch(remote);
            if (r.ok) {
                const type = r.headers.get('content-type') || '';
                const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp'
                    : type.includes('gif') ? '.gif' : '.jpg';
                const file = `${t.id}${ext}`;
                await writeFile(resolve(COVER_DIR, file), Buffer.from(await r.arrayBuffer()));
                cover = `assets/posts/${file}`;
                keep.add(file);
            }
        } catch {
            console.warn(`  … 「${t.name}」のカバー画像を取得できませんでした`);
        }
    }

    posts.push({
        id: t.id,
        title: cleanTitle(t.name),
        channel: meta.channel,
        category: meta.category,
        date: new Date(created).toISOString(),
        excerpt: msg ? excerptOf(msg.content) || null : null,
        source_url,
        source_label,
        cover,
        url: `https://discord.com/channels/${GUILD_ID}/${t.parent_id}/threads/${t.id}`,
    });
}

// 使わなくなったカバー画像を掃除
for (const f of await readdir(COVER_DIR).catch(() => [])) {
    if (!keep.has(f) && ['.jpg', '.png', '.webp', '.gif'].includes(extname(f))) {
        await unlink(resolve(COVER_DIR, f)).catch(() => { });
    }
}

await writeFile(POSTS_OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'discord-api',
    guild_id: GUILD_ID,
    posts,
}, null, 2) + '\n', 'utf8');

console.log(`✓ posts.json: ${posts.length} posts (カバー画像 ${keep.size} 枚)`);
