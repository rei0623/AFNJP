#!/usr/bin/env node
/**
 * AFNJP ─ 静的HTML / フィード生成スクリプト
 *
 * posts.json / channels.json を読んで、次の3つを更新する。
 *   1. index.html のマーカー区間 … 記事カードとチャンネル一覧を静的HTMLとして焼き込む
 *   2. feed.xml                  … 最新記事の RSS 2.0 フィード
 *   3. sitemap.xml               … lastmod を最新記事の日付で更新
 *
 * なぜ必要か:
 *   ChatGPT / Claude / Perplexity のクローラー（GPTBot, OAI-SearchBot, ClaudeBot,
 *   PerplexityBot）は JavaScript を実行しない。記事一覧とチャンネル一覧は JS が
 *   posts.json / channels.json を fetch して描画しているため、これらのクローラーからは
 *   「空のページ」に見えてしまう。ビルド時に HTML へ書き込むことで読めるようにする。
 *   （Googlebot / Bingbot は JS を実行するので、こちらは元から読めている）
 *
 * 安全設計 ─ サイトは index.html 1枚なので、壊れた HTML をコミットさせないことを最優先する:
 *   - マーカーが「ちょうど1組ずつ」存在することを確認し、異常なら書き込まずに終了する
 *   - 生成内容に HTML コメントが混入していないことを確認する（マーカーの偽造防止）
 *   - マーカー区間の外側が1文字も変わっていないことを検証する
 *   - 出力全体の構造チェック（</html> の数、カード数、サイズの妥当性）を通す
 *   - すべての検証を通ってから、一時ファイル経由で rename して書き込む
 *   - Discord 由来の文字列はすべてエスケープし、URL は許可リストで検証する
 *
 * 冪等性:
 *   同じ posts.json / channels.json に対して何度実行しても出力は同一になる。
 *   日付は「今日 / 昨日」のような相対表記を使わず絶対表記にし、lastBuildDate や
 *   lastmod も実行時刻ではなく最新記事の日付から導く。
 *
 * 使い方:
 *   node scripts/generate-seo.mjs
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const INDEX = resolve(ROOT, 'index.html');
const POSTS_JSON = resolve(ROOT, 'posts.json');
const CHANNELS_JSON = resolve(ROOT, 'channels.json');
const FEED = resolve(ROOT, 'feed.xml');
const SITEMAP = resolve(ROOT, 'sitemap.xml');

const SITE = 'https://rei0623.github.io/AFNJP/';
const FEED_URL = `${SITE}feed.xml`;
const SITE_TITLE = 'AI Frontier News JP';
const SITE_DESC = '海外のAIニュースを、管理人が公式発表やリリースノートなどの一次情報を直接確認して、'
    + '出典リンク付きで日本語記事にして投稿しているDiscordコミュニティ。';

/** index.html に表示する記事の数（renderPosts の slice と合わせる） */
const VISIBLE_POSTS = 9;
/** feed.xml に載せる記事の数（posts.json の全件） */
const FEED_POSTS = 12;

/** 記事リンクとして許可するホスト。これ以外はカードごと捨てる */
const ALLOWED_LINK_HOSTS = new Set([
    'discord.com', 'canary.discord.com', 'ptb.discord.com', 'discordapp.com',
]);
/** カバー画像として許可する相対パス */
const COVER_PATH = /^assets\/posts\/[A-Za-z0-9._-]+$/;

/* ═══════════ 小さな道具 ═══════════ */

/**
 * 出力に混ぜてはいけない文字。
 * XML 1.0 が禁じる C0 制御文字と、対を欠いたサロゲートを対象にする。
 * HTML はこれらがあってもブラウザが読み飛ばすが、XML は1文字でパース全体が失敗する。
 * Discord の本文にターミナル出力や PDF からの貼り付けが混じると ESC(U+001B) などが
 * 紛れ込みうるため、HTML / XML の両方から除去する。
 * タブ・改行・復帰(U+0009 / U+000A / U+000D)は有効な文字なので残す。
 */
const FORBIDDEN_SRC = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]';
const LONE_SURROGATE_SRC = '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';

// 除去用は g 付き、判定用は g なし。g 付きの正規表現に test() を使うと
// lastIndex が進んで2回目以降の結果が変わってしまうため、用途ごとに分ける。
const FORBIDDEN_G = new RegExp(FORBIDDEN_SRC, 'g');
const LONE_SURROGATE_G = new RegExp(LONE_SURROGATE_SRC, 'g');
const hasUnsafeChars = text =>
    new RegExp(FORBIDDEN_SRC).test(text) || new RegExp(LONE_SURROGATE_SRC).test(text);

const stripUnsafeChars = s => String(s ?? '')
    .replace(LONE_SURROGATE_G, '')
    .replace(FORBIDDEN_G, '');

/** HTML のテキスト・属性値の両方に使えるエスケープ。' も落とす（属性を壊さないため） */
const escHtml = s => stripUnsafeChars(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** XML のエスケープ。& を素で出すと feed が parse error になる */
const escXml = escHtml;

/**
 * 記事リンクの検証。https かつ許可ホストのものだけ通す。
 * javascript: や data: のような危険なスキームをここで止める。
 */
function safeLink(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    if (!ALLOWED_LINK_HOSTS.has(url.hostname)) return null;
    return url.href;
}

/** カバー画像の検証。リポジトリ内の相対パスだけ通す（.. や scheme を弾く） */
function safeCover(value) {
    const s = String(value ?? '');
    return COVER_PATH.test(s) ? s : null;
}

/** ISO 文字列から JST の年月日を得る。実行環境のタイムゾーンに依存させない */
function jstDate(iso) {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return null;
    const jst = new Date(t.getTime() + 9 * 3600 * 1000);
    const p2 = n => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}.${p2(jst.getUTCMonth() + 1)}.${p2(jst.getUTCDate())}`;
}

/** 各行に指定量のインデントを付ける */
const indent = (text, pad) => text.split('\n').map(l => (l ? pad + l : l)).join('\n');

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/* ═══════════ マーカー置換 ═══════════ */

/**
 * <!-- NAME:START ... --> と <!-- NAME:END --> の間を探す。
 * ちょうど1組でなければ例外にして、書き込みに進ませない。
 */
function markerRange(html, name) {
    const startHead = `<!-- ${name}:START`;
    const endTag = `<!-- ${name}:END -->`;

    const starts = countOf(html, startHead);
    const ends = countOf(html, endTag);
    if (starts !== 1 || ends !== 1) {
        throw new Error(`マーカー ${name} が ${starts} 個 / ${ends} 個 見つかりました（各1個であるべきです）`);
    }

    const startIdx = html.indexOf(startHead);
    const startClose = html.indexOf('-->', startIdx);
    if (startClose < 0) throw new Error(`マーカー ${name}:START が閉じられていません`);

    const innerStart = startClose + 3;
    const innerEnd = html.indexOf(endTag);
    if (innerEnd < innerStart) {
        throw new Error(`マーカー ${name} の START と END の順序が逆です`);
    }
    return { innerStart, innerEnd };
}

/**
 * マーカー区間の中身だけを差し替える。
 * 置換後にもう一度マーカーを探し直し、外側が1文字も変わっていないことを検証する。
 */
function replaceMarkerBlock(html, name, inner) {
    if (inner.includes('<!--') || inner.includes('-->')) {
        throw new Error(`${name}: 生成内容に HTML コメントが含まれています（マーカーを壊す恐れがあります）`);
    }

    const { innerStart, innerEnd } = markerRange(html, name);
    const before = html.slice(0, innerStart);
    const after = html.slice(innerEnd);
    const out = before + inner + after;

    const check = markerRange(out, name);
    if (out.slice(0, check.innerStart) !== before || out.slice(check.innerEnd) !== after) {
        throw new Error(`${name}: マーカー区間の外側が変化しました`);
    }
    return out;
}

/* ═══════════ 記事カードの HTML ═══════════ */

/** index.html の renderPosts と同じ形の稜線SVG（カバー画像がない記事の代替） */
const RIDGE_SVG =
    '<svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">'
    + '<path d="M0 60 L36 34 L58 44 L92 18 L120 38 L150 12 L182 40 L214 26 L246 46 L272 30 L300 52 L300 60 Z" '
    + 'fill="#efeee8"/><path d="M0 60 L36 34 L58 44 L92 18 L120 38 L150 12 L182 40 L214 26 L246 46 L272 30 L300 52" '
    + 'fill="none" stroke="#d8d5cc" stroke-width="1"/></svg>';

function cardHtml(post, i) {
    const href = safeLink(post.url);
    if (!href) return null; // リンクが検証を通らない記事は載せない

    const cover = safeCover(post.cover);
    const coverHtml = cover
        // カード全体が1つのリンクで、直下の h3 に同じタイトルがあるため装飾扱い（alt=""）
        ? `<div class="cover"><img src="${escHtml(cover)}" alt="" loading="lazy"></div>`
        : `<div class="cover blank">${RIDGE_SVG}<span class="ch"># ${escHtml(post.channel)}</span></div>`;

    // 静的版は「今日 / 昨日」のような相対表記を使わない。
    // 相対表記はクロールされた時点が分からないと意味を持たず、
    // 記事が変わっていないのに毎日差分が出て無駄なコミットを生むため。
    const shown = jstDate(post.date);
    const when = shown
        ? `<span><time datetime="${escHtml(post.date)}">${escHtml(shown)}</time></span>`
        : '';

    const delay = Math.min(i * 45, 400);

    return `<a class="card" style="animation-delay:${delay}ms"
    href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">
    ${coverHtml}
    <div class="body">
        <p class="meta"><span class="tag">#${escHtml(post.channel)}</span>${when}</p>
        <h3>${escHtml(post.title)}</h3>
        ${post.excerpt ? `<p class="ex">${escHtml(post.excerpt)}</p>` : ''}
        <p class="foot">
            <span class="src">${post.source_label ? '出典 ' + escHtml(post.source_label) : ''}</span>
            <span class="go">Discordで読む ↗</span>
        </p>
    </div>
</a>`;
}

/* ═══════════ チャンネル一覧の HTML ═══════════ */

function groupHtml(group, startIndex) {
    const names = (group.channels || []).filter(n => String(n ?? '').trim());
    if (!names.length) return { html: null, used: 0 };

    const chips = names.map((name, k) => {
        const delay = Math.min((startIndex + k) * 8, 280);
        return `    <span class="ch" style="animation-delay:${delay}ms"><span class="h">#</span>${escHtml(name)}</span>`;
    }).join('\n');

    const html = `<div class="group">
    <h4>${escHtml(group.category)}<span class="n">${names.length}</span></h4>
    <div class="chlist">
${chips}
    </div>
</div>`;
    return { html, used: names.length };
}

/* ═══════════ feed.xml ═══════════ */

function buildFeed(posts, latestIso) {
    const items = posts.map(p => {
        const href = safeLink(p.url);
        if (!href) return null;
        const date = new Date(p.date);
        const pubDate = Number.isNaN(date.getTime()) ? null : date.toUTCString();
        return [
            '    <item>',
            `      <title>${escXml(p.title)}</title>`,
            `      <link>${escXml(href)}</link>`,
            `      <guid isPermaLink="false">afnjp-${escXml(p.id)}</guid>`,
            pubDate ? `      <pubDate>${pubDate}</pubDate>` : null,
            p.channel ? `      <category>${escXml(p.channel)}</category>` : null,
            p.excerpt ? `      <description>${escXml(p.excerpt)}</description>` : null,
            '    </item>',
        ].filter(Boolean).join('\n');
    }).filter(Boolean);

    // lastBuildDate も実行時刻ではなく最新記事の日付から導く（冪等性のため）
    const built = latestIso ? new Date(latestIso).toUTCString() : null;

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <channel>',
        `    <title>${escXml(SITE_TITLE)}</title>`,
        `    <link>${SITE}</link>`,
        `    <description>${escXml(SITE_DESC)}</description>`,
        '    <language>ja</language>',
        built ? `    <lastBuildDate>${built}</lastBuildDate>` : null,
        `    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>`,
        ...items,
        '  </channel>',
        '</rss>',
        '',
    ].filter(v => v !== null).join('\n');
}

/* ═══════════ sitemap.xml ═══════════ */

function buildSitemap(latestIso) {
    // lastmod は「自動生成処理が把握できる範囲での最終更新日」。
    // 厳密なページ最終更新日ではない（FAQ や説明文の手直しはここに現れない）。
    // 実行時刻を書くと毎時更新になり、Google に lastmod ごと無視されるため使わない。
    //
    // sitemap の lastmod は W3C Datetime 形式で、ミリ秒は許容されない。
    // toISOString() の "2026-08-04T14:12:10.731Z" をそのまま書くと
    // Google に「サイトマップを読み込めませんでした」と弾かれるため、
    // 秒までに丸めた "2026-08-04T14:12:10Z" にする。
    const lastmod = latestIso
        ? new Date(latestIso).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url>',
        `    <loc>${SITE}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
        '  </url>',
        '</urlset>',
        '',
    ].filter(v => v !== null).join('\n');
}

/* ═══════════ 本体 ═══════════ */

const [srcHtml, postsData, channelsData] = await Promise.all([
    readFile(INDEX, 'utf8'),
    readFile(POSTS_JSON, 'utf8').then(JSON.parse),
    readFile(CHANNELS_JSON, 'utf8').then(JSON.parse),
]);

const allPosts = Array.isArray(postsData.posts) ? postsData.posts : [];
const groups = Array.isArray(channelsData.groups) ? channelsData.groups : [];

if (!allPosts.length) {
    console.error('✗ posts.json に記事がありません。index.html は変更しません。');
    process.exit(1);
}
if (!groups.length) {
    console.error('✗ channels.json にチャンネルがありません。index.html は変更しません。');
    process.exit(1);
}

/* ── 記事カード ── */
const visible = allPosts.slice(0, VISIBLE_POSTS);
const cards = visible.map(cardHtml).filter(Boolean);
const skippedCards = visible.length - cards.length;
if (skippedCards) {
    console.warn(`  … リンクが検証を通らなかった記事 ${skippedCards} 件をカードから除きました`);
}
if (!cards.length) {
    console.error('✗ 載せられる記事カードが1件もありません。index.html は変更しません。');
    process.exit(1);
}

/* ── チャンネル一覧 ── */
const groupBlocks = [];
let chIndex = 0;
let channelTotal = 0;
for (const g of groups) {
    const { html, used } = groupHtml(g, chIndex);
    if (!html) continue;
    groupBlocks.push(html);
    chIndex += used;
    channelTotal += used;
}
if (!groupBlocks.length) {
    console.error('✗ 載せられるチャンネルが1件もありません。index.html は変更しません。');
    process.exit(1);
}

/* ── index.html を組み立てる ── */
const PAD = ' '.repeat(20); // マーカー内側のインデント（#cards / #groups の中）

let outHtml;
try {
    outHtml = replaceMarkerBlock(srcHtml, 'POSTS',
        '\n' + indent(cards.join('\n'), PAD) + '\n' + PAD);
    outHtml = replaceMarkerBlock(outHtml, 'CHANNELS',
        '\n' + indent(groupBlocks.join('\n'), PAD) + '\n' + PAD);
} catch (err) {
    console.error('✗ index.html のマーカー処理に失敗しました。ファイルは変更しません。');
    console.error(`   - ${err.message}`);
    console.error('   index.html のマーカー（POSTS / CHANNELS）が壊れていないか確認してください。');
    process.exit(1);
}

/* ── 出力全体の構造チェック ── */
/** マーカー区間の中身だけを取り出す。数え上げはページ全体ではなくこの中で行う
 *  （renderPosts のテンプレート文字列にも同じタグが現れるため） */
function innerOf(html, name) {
    const { innerStart, innerEnd } = markerRange(html, name);
    return html.slice(innerStart, innerEnd);
}

const problems = [];
if (countOf(outHtml, '</html>') !== 1) problems.push('</html> がちょうど1つではありません');

for (const name of ['POSTS', 'CHANNELS']) {
    if (countOf(outHtml, `<!-- ${name}:START`) !== 1 || countOf(outHtml, `<!-- ${name}:END -->`) !== 1) {
        problems.push(`マーカー ${name} が失われました`);
    }
}
if (!problems.length) {
    const postsInner = innerOf(outHtml, 'POSTS');
    const channelsInner = innerOf(outHtml, 'CHANNELS');
    const cardCount = countOf(postsInner, '<a class="card"');
    const groupCount = countOf(channelsInner, '<div class="group">');
    const chipCount = countOf(channelsInner, '<span class="ch"');
    if (cardCount !== cards.length) {
        problems.push(`カード数が ${cardCount} 件で、期待の ${cards.length} 件と一致しません`);
    }
    if (groupCount !== groupBlocks.length) {
        problems.push(`カテゴリ数が ${groupCount} 件で、期待の ${groupBlocks.length} 件と一致しません`);
    }
    if (chipCount !== channelTotal) {
        problems.push(`チャンネル数が ${chipCount} 件で、期待の ${channelTotal} 件と一致しません`);
    }
    // 閉じタグの数が開始タグと合っているか（マークアップ破壊の検知）
    if (countOf(postsInner, '</a>') !== cards.length) {
        problems.push('カードの </a> の数が合いません');
    }
}
if (outHtml.length < srcHtml.length * 0.5 || outHtml.length > srcHtml.length * 2) {
    problems.push(`出力サイズが不自然です（${srcHtml.length} → ${outHtml.length} バイト）`);
}

/* ── feed.xml / sitemap.xml も同じゲートで検証する ──
   XML は1文字でもパース不能になると全体が読めなくなるため、
   index.html と同じく「検証を通ってから書く」方針に揃える。 */
const dates = allPosts.map(p => new Date(p.date).getTime()).filter(t => !Number.isNaN(t));
const latestIso = dates.length ? new Date(Math.max(...dates)).toISOString() : null;

const feedPosts = allPosts.slice(0, FEED_POSTS);
const feedXml = buildFeed(feedPosts, latestIso);
const sitemapXml = buildSitemap(latestIso);

const expectedItems = feedPosts.filter(p => safeLink(p.url)).length;
if (countOf(feedXml, '<item>') !== expectedItems) {
    problems.push(`feed.xml の item 数が ${countOf(feedXml, '<item>')} 件で、期待の ${expectedItems} 件と一致しません`);
}
if (countOf(feedXml, '<item>') !== countOf(feedXml, '</item>')) {
    problems.push('feed.xml の <item> と </item> の数が一致しません');
}
// 検査対象は「このスクリプトが生成した部分」に限る。
// index.html 全体を対象にすると、マーカー外に想定外の文字が1つあるだけで
// 以後ずっと更新が止まってしまうため。
for (const [label, text] of [
    ['index.html の記事カード', cards.join('')],
    ['index.html のチャンネル一覧', groupBlocks.join('')],
    ['feed.xml', feedXml],
    ['sitemap.xml', sitemapXml],
]) {
    if (hasUnsafeChars(text)) {
        problems.push(`${label}に出力してはいけない文字（制御文字など）が残っています`);
    }
}
for (const [label, xml] of [['feed.xml', feedXml], ['sitemap.xml', sitemapXml]]) {
    if (!xml.trimEnd().endsWith('>')) problems.push(`${label} が途中で終わっています`);
}
if (!feedXml.trimEnd().endsWith('</rss>')) problems.push('feed.xml が </rss> で終わっていません');
if (!sitemapXml.trimEnd().endsWith('</urlset>')) problems.push('sitemap.xml が </urlset> で終わっていません');

if (problems.length) {
    console.error('✗ 生成結果の検証に失敗しました。ファイルは変更しません。');
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
}

/* ── すべての検証を通ってから書き込む（一時ファイル経由で rename） ── */
async function writeAtomic(path, content) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
}

const changed = [];
for (const [path, content, label] of [
    [INDEX, outHtml, 'index.html'],
    [FEED, feedXml, 'feed.xml'],
    [SITEMAP, sitemapXml, 'sitemap.xml'],
]) {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === content) continue;
    await writeAtomic(path, content);
    changed.push(label);
}

console.log(`✓ 静的化: 記事カード ${cards.length} 件 / チャンネル ${channelTotal} 件`);
console.log(`✓ feed.xml: ${countOf(feedXml, '<item>')} 件（最新 ${latestIso ?? '不明'}）`);
console.log(changed.length ? `✓ 更新: ${changed.join(', ')}` : '✓ 変化なし（すべて最新）');
