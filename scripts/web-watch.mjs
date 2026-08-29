#!/usr/bin/env node
/**
 * AFNJP ─ 各社の公式ブログを見張って、新着を Discord へ流す
 *
 * 狙い:
 *   記事を書く前の「発表があったこと」自体を、人が巡回するより早く掴む。
 *   拾うのは公開済みのブログ記事だけで、未公開ページ（リーク）は狙わない。
 *   これは「一次情報を確認して書く」という運営方針に沿わせるための線引きで、
 *   sitemap を使う場合も include でブログのパスだけに絞っている。
 *
 * 2つの取り方:
 *   rss     … フィードがある会社。タイトルと日付がそのまま取れる
 *   sitemap … フィードが無い会社。新しく現れた URL を検出し、
 *             そのページを1回だけ取ってタイトルを読む
 *
 * 状態の置き場所:
 *   5分ごとに動くため、既読URLをリポジトリに置くと履歴が汚れる。
 *   Cloudflare Worker 経由で KV に保存する（/watch/state）。
 *
 * 記事化の判定:
 *   posts-archive.json の source_url と突き合わせ、AFNJP で既に記事化したかを示す。
 *   検知の時点ではまず未記事化なので、このチャンネルが
 *   「まだ書いていない発表」の一覧として機能する。
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN … Bot トークン（投稿先チャンネルへの「メッセージを送信」権限が必要）
 *   WATCH_CHANNEL_ID  … 投稿先チャンネルID（省略時は #一次情報ウォッチ）
 *   PUSH_SEND_TOKEN   … Worker の /watch/state を読み書きするための合言葉
 *
 * どれかが欠けているときは何もせず正常終了する。
 *
 * 使い方:
 *   DISCORD_BOT_TOKEN=xxx PUSH_SEND_TOKEN=yyy node scripts/web-watch.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCES = resolve(ROOT, 'watch-sources.json');
const ARCHIVE = resolve(ROOT, 'posts-archive.json');
const CONFIG = resolve(ROOT, 'push-config.json');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.WATCH_CHANNEL_ID || '1543192400237699112';
const STATE_TOKEN = process.env.PUSH_SEND_TOKEN;

/**
 * 1ソースあたり覚えておく既読URLの数。
 * sitemap は全件（Anthropic 432 / HuggingFace 852 など）を返すので、
 * ここを小さくすると溢れたぶんが「新着」として何度も出てしまう。多めに取る。
 */
const KEEP_PER_SOURCE = 3000;
/** 1回の実行で投稿する上限。何かの拍子に大量投下されるのを防ぐ */
const MAX_POST_PER_RUN = 12;
/** 取得のタイムアウト */
const TIMEOUT_MS = 15000;

/**
 * 素性を明かしつつ、一般的なクローラーの書式に合わせる。
 * "Mozilla/5.0 (compatible; ...)" は Googlebot などと同じ形で、
 * これを外すと一部のサイト（x.ai など）が 403 を返す。
 */
const UA = 'Mozilla/5.0 (compatible; AFNJP-web-watch/1.0; +https://rei0623.github.io/AFNJP/)';

/**
 * --dry-run … 状態も Discord も触らず、各ソースから何件取れるかだけを見る。
 * 監視先を足したときに、その定義が正しいかを手元で確かめるためのもの。
 */
const DRY = process.argv.includes('--dry-run');

if (!DRY && !TOKEN) {
    console.log('… DISCORD_BOT_TOKEN が未設定のため、監視をスキップします。');
    process.exit(0);
}
if (!DRY && !STATE_TOKEN) {
    console.log('… PUSH_SEND_TOKEN が未設定のため、監視をスキップします。');
    process.exit(0);
}

const config = await readFile(CONFIG, 'utf8').then(JSON.parse).catch(() => null);
if (!DRY && !config?.endpoint) {
    console.log('… 状態の保存先が未設定のため、監視をスキップします。');
    process.exit(0);
}
const STATE_URL = (config?.endpoint || '').replace(/\/+$/, '') + '/watch/state';

/* ═══════════ 取得の道具 ═══════════ */

async function get(url, accept = 'text/html,application/xhtml+xml,application/xml') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, Accept: accept },
            redirect: 'follow',
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/** XML/HTML のエンティティを戻す。タイトルにそのまま出ると読みにくいため */
const unescapeXml = s => String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const tagOf = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? unescapeXml(m[1]) : null;
};

/* ═══════════ アダプタ: RSS / Atom ═══════════ */

function parseFeed(xml) {
    const out = [];
    // <item>（RSS 2.0）と <entry>（Atom）の両方を拾う
    for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
        const block = m[0];
        const title = tagOf(block, 'title');

        // Atom は <link href="..."/>、RSS は <link>...</link>
        let link = tagOf(block, 'link');
        if (!link || !/^https?:/i.test(link)) {
            const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
                || block.match(/<link[^>]*href=["']([^"']+)["']/i);
            link = alt ? unescapeXml(alt[1]) : null;
        }

        const date = tagOf(block, 'pubDate') || tagOf(block, 'published') || tagOf(block, 'updated');
        if (title && link) out.push({ title, url: link, date });
    }
    return out;
}

/* ═══════════ アダプタ: sitemap ═══════════ */

const locsOf = xml => [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => unescapeXml(m[1]));

/**
 * sitemap を読んで、対象パスに合う URL を返す。
 * sitemapindex だった場合は子を辿る（Mistral / Perplexity / ElevenLabs がこの形）。
 */
async function readSitemap(source) {
    const xml = await get(source.url, 'application/xml,text/xml');
    let urls;

    if (/<sitemapindex/i.test(xml)) {
        const children = locsOf(xml).slice(0, 12); // 際限なく辿らない
        urls = [];
        for (const child of children) {
            try {
                const sub = await get(child, 'application/xml,text/xml');
                urls.push(...locsOf(sub));
            } catch { /* 一部が落ちても他は続ける */ }
        }
    } else {
        urls = locsOf(xml);
    }

    const include = source.include ? new RegExp(source.include) : null;
    const seen = new Set();
    const out = [];
    for (const u of urls) {
        let path;
        try {
            path = new URL(u).pathname.replace(/\/$/, '');
        } catch {
            continue;
        }
        if (include && !include.test(path)) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push({ title: null, url: u, date: null });
    }
    return out;
}

/** sitemap 由来の記事はタイトルが無いので、ページを1回だけ取って読む */
async function titleOf(url) {
    try {
        const html = await get(url);
        const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
        if (og) return unescapeXml(og[1]);
        const t = tagOf(html, 'title');
        if (t) return t.split(/\s+[|｜–—-]\s+/)[0].trim() || t;
    } catch { /* 取れなければ URL だけで出す */ }
    return null;
}

/* ═══════════ 記事化ずみかの判定 ═══════════ */

/** 比較用に URL をならす。末尾スラッシュ・クエリ・www の有無で取りこぼさないため */
function normalize(u) {
    try {
        const x = new URL(u);
        return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase();
    } catch {
        return String(u).toLowerCase();
    }
}

const archive = await readFile(ARCHIVE, 'utf8').then(JSON.parse).catch(() => null);
const covered = new Set(
    (archive?.posts || []).map(p => p.source_url).filter(Boolean).map(normalize));

/* ═══════════ 状態 ═══════════ */

async function loadState() {
    const res = await fetch(STATE_URL, { headers: { Authorization: `Bearer ${STATE_TOKEN}` } });
    if (!res.ok) throw new Error(`状態を読めません: ${res.status} ${await res.text()}`);
    return res.json();
}

async function saveState(state) {
    const res = await fetch(STATE_URL, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${STATE_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(`状態を保存できません: ${res.status} ${await res.text()}`);
}

/* ═══════════ Discord ═══════════ */

async function postToDiscord(embeds) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': UA,
        },
        body: JSON.stringify({ embeds }),
    });
    if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 2);
        await new Promise(r => setTimeout(r, retry * 1000 + 250));
        return postToDiscord(embeds);
    }
    if (!res.ok) throw new Error(`Discord ${res.status} — ${await res.text()}`);
    return res.json();
}

/** 会社ごとに色を変える。ひと目でどこの発表か分かるように */
const COLOR = {
    'Open AI': 0x10a37f, Anthropic: 0xd97757, Google: 0x4285f4,
    Microsoft: 0x00a4ef, Meta: 0x0064e0, 'Space X': 0x111111,
    Alibaba: 0xff6a00, その他: 0x8b8e93,
};

function embedOf(item, source) {
    const isCovered = covered.has(normalize(item.url));
    const when = item.date ? new Date(item.date) : null;

    return {
        author: { name: source.label },
        title: (item.title || item.url).slice(0, 250),
        url: item.url,
        description: isCovered ? '✅ AFNJP で記事化ずみ' : '🔴 未記事化',
        color: COLOR[source.category] ?? COLOR['その他'],
        timestamp: when && !Number.isNaN(when.getTime()) ? when.toISOString() : new Date().toISOString(),
        footer: { text: `一次情報ウォッチ · ${source.category}` },
    };
}

/* ═══════════ 本処理 ═══════════ */

const { sources } = JSON.parse(await readFile(SOURCES, 'utf8'));
const state = DRY ? {} : await loadState();

if (DRY) {
    // 各ソースが実際に何件返すかを一覧する。定義の確認用で、投稿も保存もしない。
    const rows = await Promise.all(sources.map(async source => {
        try {
            const items = source.type === 'rss'
                ? parseFeed(await get(source.url, 'application/rss+xml,application/xml,text/xml'))
                : await readSitemap(source);
            return { source, count: items.length, sample: items[0] };
        } catch (e) {
            return { source, count: -1, error: e.message };
        }
    }));

    let ng = 0;
    for (const r of rows.sort((a, b) => a.source.label.localeCompare(b.source.label))) {
        if (r.count <= 0) {
            ng++;
            console.log(`✗ ${r.source.label.padEnd(18)} ${r.error || '0件'}`);
            continue;
        }
        const t = r.sample.title || r.sample.url.replace(/^https?:\/\//, '');
        console.log(`✓ ${r.source.label.padEnd(18)} ${String(r.count).padStart(4)}件  ${t.slice(0, 62)}`);
    }
    console.log(`\n${sources.length} ソース中 ${sources.length - ng} 件が取得できました。`);
    process.exit(ng ? 1 : 0);
}

const found = [];   // 今回の新着
const errors = [];  // 取得に失敗したソース
let seeded = 0;     // 初回登録したソース数

// 各社を並行に見る。1社が落ちても他は続ける
await Promise.all(sources.map(async source => {
    let items;
    try {
        items = source.type === 'rss'
            ? parseFeed(await get(source.url, 'application/rss+xml,application/xml,text/xml'))
            : await readSitemap(source);
    } catch (e) {
        errors.push(`${source.label}: ${e.message}`);
        return;
    }
    if (!items.length) {
        errors.push(`${source.label}: 0件（形式が変わった可能性）`);
        return;
    }

    const known = state[source.id];

    // 初回は「取れた全部」を既読として登録するだけ。
    // ここで件数を絞ると、溢れたぶんが次回以降に過去記事として流れ続けてしまう。
    if (!Array.isArray(known)) {
        state[source.id] = items.map(i => i.url).slice(0, KEEP_PER_SOURCE);
        seeded++;
        return;
    }

    const seen = new Set(known);
    const fresh = items.filter(i => !seen.has(i.url));
    if (!fresh.length) return;

    // 新しいものから順に。ただし1ソースが暴発しても他を潰さないよう頭を切る
    for (const item of fresh.slice(0, MAX_POST_PER_RUN)) {
        found.push({ item, source });
    }
    // 既読には「取れた全部」を入れる。投稿を絞っても取りこぼしを繰り返さないため
    state[source.id] = [...items.map(i => i.url), ...known].slice(0, KEEP_PER_SOURCE);
}));

if (seeded) {
    console.log(`✓ 初回セットアップ: ${seeded} ソースの現在の記事を既読として登録しました。`);
}
for (const e of errors) console.warn(`  … ${e}`);

if (!found.length) {
    if (seeded) await saveState(state);
    console.log(`✓ 新着なし（監視 ${sources.length} ソース / 失敗 ${errors.length}）`);
    process.exit(0);
}

// 新しい順に並べ、投稿数に上限をかける
found.sort((a, b) => new Date(b.item.date || 0) - new Date(a.item.date || 0));
const targets = found.slice(0, MAX_POST_PER_RUN);

// sitemap 由来はタイトルが無いので、投稿するぶんだけ取りに行く
for (const t of targets) {
    if (!t.item.title) t.item.title = await titleOf(t.item.url);
}

let posted = 0;
try {
    // Discord は1メッセージに埋め込み10件まで
    for (let i = 0; i < targets.length; i += 10) {
        const batch = targets.slice(i, i + 10);
        await postToDiscord(batch.map(t => embedOf(t.item, t.source)));
        posted += batch.length;
        if (i + 10 < targets.length) await new Promise(r => setTimeout(r, 800));
    }
} catch (e) {
    // 投稿できなかったぶんは既読にしない → 次回やり直せる
    console.error(`✗ Discord への投稿に失敗しました: ${e.message}`);
    if (!posted) process.exit(1);
}

await saveState(state);

console.log(`✓ 一次情報ウォッチ: ${posted} 件を投稿`
    + `（新着 ${found.length} / 監視 ${sources.length} ソース`
    + (errors.length ? ` / 失敗 ${errors.length}` : '') + '）');
for (const t of targets.slice(0, posted)) {
    console.log(`   ${t.source.label}: ${t.item.title || t.item.url}`);
}
