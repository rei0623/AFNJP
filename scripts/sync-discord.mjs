#!/usr/bin/env node
/**
 * AFNJP ─ サイト用データ同期スクリプト
 *
 * Discord の Bot トークンでサーバーの状態を取得し、次の4つを更新する。
 *   1. channels.json      … カテゴリ別のチャンネル一覧と総数
 *   2. posts.json         … 各フォーラムの最新投稿（記事）。トップに出す直近ぶんだけ
 *   3. posts-archive.json … 過去記事の蓄積。追記のみで、消さない
 *   4. assets/posts/      … 記事のカバー画像（DiscordのCDN URLは期限切れになるため取り込む）
 *
 * カバー画像は sharp で 640px 幅の WebP に変換してから保存する。
 * 元画像は 1〜2MB の PNG が珍しくなく、毎時コミットされるリポジトリに
 * そのまま入れると git が肥大するため。
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

import { readFile, writeFile, mkdir, readdir, unlink, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHANNELS_OUT = resolve(ROOT, 'channels.json');
const POSTS_OUT = resolve(ROOT, 'posts.json');
const ARCHIVE_OUT = resolve(ROOT, 'posts-archive.json');
const COVER_DIR = resolve(ROOT, 'assets', 'posts');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1415350002255007784';

/** サイトに出さないカテゴリ（運営専用など） */
const PRIVATE_CATEGORIES = [/運営/];
/** 記事フィードに載せるのは、この一覧に入っていないカテゴリのフォーラム */
const NON_ARTICLE_CATEGORIES = [/運営/, /Welcome/i, /コミュニティ/, /デイリーレポート/];

/** posts.json（トップの「最近の記事」）に載せる件数 */
const MAX_POSTS = 12;
/** 1回の同期で Discord から読み取るスレッド数。アーカイブの取りこぼしを防ぐため多めにとる */
const MAX_INGEST = 40;

/** カバー画像の書き出し設定。記事カードの表示幅は 400px 前後なので 640px あれば足りる */
const COVER_WIDTH = 640;
const COVER_QUALITY = 72;

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
    .slice(0, MAX_INGEST);

function snowflakeToDate(id) {
    return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}

/** 本文から先頭の段落（リード）を抜き、Markdown記法を落とす */
function leadTextOf(content = '') {
    const body = content
        .split(/\n#{1,3}\s|\n\*\*参考文献\*\*|\n参考文献/)[0]
        .replace(/^#+\s.*$/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_`>]/g, '')
        .trim();
    const first = body.split(/\n\s*\n/).find(p => p.trim().length > 20) || body;
    return first.replace(/\s+/g, ' ').trim();
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** カード用の短い抜粋 */
function excerptOf(content = '') {
    return cut(leadTextOf(content), 130);
}

/** 個別記事ページ用の、やや長いリード */
function leadOf(content = '') {
    return cut(leadTextOf(content), 300);
}

/**
 * 本文の小見出しを拾う。
 * 記事は「リード → 小見出し3〜4本 → 留意点 → 参考文献」という構成なので、
 * 見出しだけを並べれば全文を写さずに記事の中身を示せる。
 */
function headingsOf(content = '') {
    const out = [];
    for (const m of (content || '').matchAll(/^#{1,3}\s+(.+?)\s*$/gm)) {
        const h = cleanTitle(m[1]).replace(/\*\*/g, '').trim();
        if (!h || /^参考文献/.test(h)) continue;
        if (!out.includes(h)) out.push(h);
    }
    return out.slice(0, 8);
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

/* ── 既存アーカイブ（追記のみ。過去記事は消さない） ── */
const prevArchive = await readFile(ARCHIVE_OUT, 'utf8').then(JSON.parse).catch(() => null);
const archive = new Map((prevArchive?.posts || []).map(p => [p.id, p]));

/**
 * Discord から画像を取り込み、640px 幅の WebP にして保存する。
 * すでに同じ記事の画像がディスクにあれば再取得しない（毎時の無駄なダウンロードと
 * 再エンコードを避けるため）。変換に失敗した場合は取り込みそのものを諦める
 * ―― 元の巨大な PNG をそのまま置くと git が膨らむため、画像なしのほうがましと判断する。
 */
async function fetchCover(threadId, remoteUrl) {
    const file = `${threadId}.webp`;
    const dest = resolve(COVER_DIR, file);
    const rel = `assets/posts/${file}`;

    if (await access(dest).then(() => true, () => false)) return rel;
    if (!remoteUrl) return null;

    try {
        const r = await fetch(remoteUrl);
        if (!r.ok) return null;
        const input = Buffer.from(await r.arrayBuffer());
        const output = await sharp(input, { animated: false })
            .rotate() // EXIF の向きを反映してから寸法を確定させる
            .resize({ width: COVER_WIDTH, withoutEnlargement: true })
            .webp({ quality: COVER_QUALITY })
            .toBuffer();
        await writeFile(dest, output);
        console.log(`  … 画像 ${file}: ${(input.length / 1024).toFixed(0)}KB → ${(output.length / 1024).toFixed(0)}KB`);
        return rel;
    } catch (e) {
        console.warn(`  … 画像を取り込めませんでした（${threadId}）: ${e.message}`);
        return null;
    }
}

const posts = [];

/** アーカイブに本文由来の項目がそろっていれば、本文を取り直す必要はない */
const isComplete = p => Boolean(p?.lead && p?.source_url && p?.headings?.length);

for (const { t, created } of threads) {
    const meta = forumIds.get(t.parent_id);
    const known = archive.get(t.id);

    // 記事は投稿後に書き換わらない運用なので、そろっているものは再取得しない。
    // Discord API の呼び出し回数を記事の増分ぶんに抑える。
    if (isComplete(known) && known.title === cleanTitle(t.name)) {
        posts.push(known);
        continue;
    }

    let msg = null;
    try {
        // フォーラム投稿の最初のメッセージは、スレッドIDと同じIDを持つ
        msg = await api(`/channels/${t.id}/messages/${t.id}`);
    } catch {
        console.warn(`  … 「${t.name}」の本文を取得できませんでした`);
    }

    const { source_url, source_label } = msg ? sourceOf(msg) : { source_url: null, source_label: null };

    // カバー画像を取り込む（Discord の CDN URL は期限切れになるため）
    const cover = await fetchCover(t.id, msg && coverUrlOf(msg));

    posts.push({
        id: t.id,
        title: cleanTitle(t.name),
        channel: meta.channel,
        category: meta.category,
        date: new Date(created).toISOString(),
        excerpt: msg ? excerptOf(msg.content) || null : null,
        lead: msg ? leadOf(msg.content) || null : null,
        headings: msg ? headingsOf(msg.content) : [],
        source_url,
        source_label,
        cover,
        url: `https://discord.com/channels/${GUILD_ID}/${t.parent_id}/threads/${t.id}`,
    });
}

/*
 * Discord API が一時的に空を返すことがある。そのまま書き出すと posts.json が空になり、
 * サイトから記事が消えてしまうので、1件も取れなかったときは前回の内容を残す。
 */
if (!posts.length && prevArchive?.posts?.length) {
    console.warn('⚠ 記事が1件も取得できませんでした。posts.json / posts-archive.json は更新しません。');
} else {
    // アーカイブへ追記。既存エントリは上書きするが、取得できなかった項目は前回値を活かす。
    for (const p of posts) {
        const before = archive.get(p.id);
        archive.set(p.id, {
            ...before,
            ...Object.fromEntries(Object.entries(p).filter(([, v]) =>
                v !== null && !(Array.isArray(v) && v.length === 0))),
            first_seen: before?.first_seen || p.date,
        });
    }

    const archived = [...archive.values()].sort((a, b) => new Date(b.date) - new Date(a.date));

    await writeFile(ARCHIVE_OUT, JSON.stringify({
        generated_at: new Date().toISOString(),
        source: 'discord-api',
        guild_id: GUILD_ID,
        count: archived.length,
        posts: archived,
    }, null, 2) + '\n', 'utf8');

    await writeFile(POSTS_OUT, JSON.stringify({
        generated_at: new Date().toISOString(),
        source: 'discord-api',
        guild_id: GUILD_ID,
        posts: archived.slice(0, MAX_POSTS),
    }, null, 2) + '\n', 'utf8');

    // アーカイブのどの記事からも参照されていない画像だけを消す。
    // 記事が Discord のアクティブ一覧から外れても、その画像は残す。
    const keep = new Set(archived.map(p => p.cover?.split('/').pop()).filter(Boolean));
    let removed = 0;
    for (const f of await readdir(COVER_DIR).catch(() => [])) {
        if (!keep.has(f) && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(f))) {
            await unlink(resolve(COVER_DIR, f)).catch(() => { });
            removed++;
        }
    }

    console.log(`✓ posts.json: ${Math.min(archived.length, MAX_POSTS)} posts`);
    console.log(`✓ posts-archive.json: ${archived.length} posts (新規 ${archived.length - (prevArchive?.count ?? 0)} 件)`);
    console.log(`✓ assets/posts: ${keep.size} 枚` + (removed ? `（未参照 ${removed} 枚を削除）` : ''));
}
