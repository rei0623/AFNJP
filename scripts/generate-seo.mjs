#!/usr/bin/env node
/**
 * AFNJP ─ 静的HTML / フィード生成スクリプト
 *
 * posts.json / posts-archive.json / channels.json を読んで、次の5つを更新する。
 *   1. index.html のマーカー区間 … 記事カードとチャンネル一覧を静的HTMLとして焼き込む
 *   2. posts/<id>.html           … 記事ごとの個別ページ
 *   3. archive.html              … 記事アーカイブの一覧
 *   4. feed.xml                  … 最新記事の RSS 2.0 フィード
 *   5. sitemap.xml               … トップ・アーカイブ・全記事ページのURL一覧
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
 * 記事ページの方針:
 *   本文は転載しない。リード（先頭の段落）と小見出しの一覧、そして一次情報への
 *   出典リンクだけを載せ、続きと議論は Discord へ誘導する。
 *   検索エンジンには「記事ごとの URL」を持たせつつ、コミュニティの中身は
 *   Discord に残す、という切り分け。
 *
 * 冪等性:
 *   同じ posts.json / channels.json に対して何度実行しても出力は同一になる。
 *   日付は「今日 / 昨日」のような相対表記を使わず絶対表記にし、lastBuildDate や
 *   lastmod も実行時刻ではなく最新記事の日付から導く。
 *
 * 使い方:
 *   node scripts/generate-seo.mjs
 */

import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const INDEX = resolve(ROOT, 'index.html');
const POSTS_JSON = resolve(ROOT, 'posts.json');
const ARCHIVE_JSON = resolve(ROOT, 'posts-archive.json');
const CHANNELS_JSON = resolve(ROOT, 'channels.json');
const FEED = resolve(ROOT, 'feed.xml');
const SITEMAP = resolve(ROOT, 'sitemap.xml');
const ARCHIVE_HTML = resolve(ROOT, 'archive.html');
const POSTS_DIR = resolve(ROOT, 'posts');

const SITE = 'https://rei0623.github.io/AFNJP/';
const FEED_URL = `${SITE}feed.xml`;
const SITE_TITLE = 'AI Frontier News JP';
const SITE_DESC = '海外のAIニュースを、管理人が公式発表やリリースノートなどの一次情報を直接確認して、'
    + '出典リンク付きで日本語記事にして投稿しているDiscordコミュニティ。';
const DISCORD_INVITE = 'https://discord.gg/WUWE6Ev7yh';

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

/**
 * 記事ID（Discord のスノーフレーク）の検証。
 * これがそのままファイル名 posts/<id>.html になるため、
 * 数字以外が混ざったものは受け付けない（パス外への書き出しを防ぐ）。
 */
const safeId = value => (/^[0-9]{5,25}$/.test(String(value ?? '')) ? String(value) : null);

/**
 * 一次情報（出典）のURL検証。こちらは外部サイト全般が対象なので
 * ホストの許可リストは使わず、スキームだけを https / http に絞る。
 */
function safeSource(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        return null;
    }
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
}

/** ISO 文字列を JST の年月日に割る。実行環境のタイムゾーンに依存させない */
function jstParts(iso) {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return null;
    const jst = new Date(t.getTime() + 9 * 3600 * 1000);
    return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1, d: jst.getUTCDate() };
}

const p2 = n => String(n).padStart(2, '0');

/** 「2026.08.19」形式（カード・一覧用） */
function jstDate(iso) {
    const p = jstParts(iso);
    return p ? `${p.y}.${p2(p.m)}.${p2(p.d)}` : null;
}

/** 「2026年8月19日」形式（記事ページの本文用） */
function jstLongDate(iso) {
    const p = jstParts(iso);
    return p ? `${p.y}年${p.m}月${p.d}日` : null;
}

/** 「2026年8月」形式（アーカイブの見出し用） */
function jstMonth(iso) {
    const p = jstParts(iso);
    return p ? `${p.y}年${p.m}月` : null;
}

/** 月ごとのグループ化キー。降順に並べたいので YYYY-MM の文字列にする */
function jstMonthKey(iso) {
    const p = jstParts(iso);
    return p ? `${p.y}-${p2(p.m)}` : null;
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
    // カードの行き先はサイト内の記事ページ。ID が検証を通らないものだけ
    // 従来どおり Discord へ直接リンクする。
    const id = safeId(post.id);
    const discord = safeLink(post.url);
    const href = id ? `posts/${id}.html` : discord;
    if (!href) return null; // 行き先が決まらない記事は載せない
    const external = !id;

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

    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    const go = external ? 'Discordで読む ↗' : '記事を読む →';

    return `<a class="card" style="animation-delay:${delay}ms"
    href="${escHtml(href)}"${attrs}>
    ${coverHtml}
    <div class="body">
        <p class="meta"><span class="tag">#${escHtml(post.channel)}</span>${when}</p>
        <h3>${escHtml(post.title)}</h3>
        ${post.excerpt ? `<p class="ex">${escHtml(post.excerpt)}</p>` : ''}
        <p class="foot">
            <span class="src">${post.source_label ? '出典 ' + escHtml(post.source_label) : ''}</span>
            <span class="go">${go}</span>
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

/* ═══════════ 個別記事ページ / アーカイブ一覧 ═══════════ */

/**
 * JSON-LD を <script> の中に安全に埋める。
 * "<" をエスケープしないと、本文に "</script>" があった場合に
 * スクリプトタグが途中で閉じてしまう。
 */
const jsonLd = obj => stripUnsafeChars(JSON.stringify(obj, null, 2)).replace(/</g, '\\u003C');

/** ページ共通のヘッダー。depth は階層の深さ（posts/ の中なら 1） */
function siteHeader(depth) {
    const up = '../'.repeat(depth);
    return `<header class="hd">
    <div class="wrap">
        <a href="${up}index.html" style="display:flex;align-items:center;gap:10px">
            <img src="${up}AFNJP.jpg" alt="" width="30" height="30">
            <b>AI Frontier News JP</b>
        </a>
        <nav>
            <a href="${up}archive.html">記事一覧</a>
            <a href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Discordに参加</a>
        </nav>
    </div>
</header>`;
}

function siteFooter(depth) {
    const up = '../'.repeat(depth);
    return `<footer class="ft">
    <div class="wrap">
        <a href="${up}index.html">トップ</a>
        <a href="${up}archive.html">記事一覧</a>
        <a href="${up}feed.xml">RSS</a>
        <a href="https://x.com/AI_FrontierNews" target="_blank" rel="noopener noreferrer">X</a>
        <span class="r">AI Frontier News JP</span>
    </div>
</footer>`;
}

/** 記事ページの meta description。リードを検索結果に収まる長さへ詰める */
function metaDesc(post) {
    const base = String(post.lead || post.excerpt || '').replace(/\s+/g, ' ').trim();
    if (!base) return SITE_DESC;
    return base.length > 158 ? base.slice(0, 157) + '…' : base;
}

/**
 * 記事1本ぶんのページ。
 * 本文は載せず、リード・小見出し・出典・Discordへの導線だけを置く。
 */
function articleHtml(post) {
    const id = safeId(post.id);
    if (!id) return null;

    const url = `${SITE}posts/${id}.html`;
    const cover = safeCover(post.cover);
    const source = safeSource(post.source_url);
    const discord = safeLink(post.url);
    const iso = new Date(post.date);
    const isoStr = Number.isNaN(iso.getTime()) ? null : iso.toISOString();
    const shownDate = jstLongDate(post.date);
    const ogImage = cover ? SITE + cover : `${SITE}AFNJP.jpg`;
    const desc = metaDesc(post);
    // lead は同期スクリプトが入れる長めの要約。まだ無い記事は短い excerpt で代用する。
    const lead = post.lead || post.excerpt || '';
    const headings = (post.headings || [])
        .map(h => String(h ?? '').trim())
        .filter(Boolean)
        .slice(0, 8);

    const ld = jsonLd({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'NewsArticle',
                headline: stripUnsafeChars(post.title).slice(0, 110),
                description: desc,
                inLanguage: 'ja-JP',
                mainEntityOfPage: { '@type': 'WebPage', '@id': url },
                url,
                ...(isoStr ? { datePublished: isoStr, dateModified: isoStr } : {}),
                image: [ogImage],
                articleSection: stripUnsafeChars(post.category || ''),
                author: { '@type': 'Organization', name: SITE_TITLE, url: SITE },
                publisher: { '@id': `${SITE}#org` },
                ...(source ? { isBasedOn: source, citation: source } : {}),
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'トップ', item: SITE },
                    { '@type': 'ListItem', position: 2, name: '記事一覧', item: `${SITE}archive.html` },
                    { '@type': 'ListItem', position: 3, name: stripUnsafeChars(post.title) },
                ],
            },
        ],
    });

    return `<!DOCTYPE html>
<html lang="ja">

<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(post.title)} | AI Frontier News JP</title>
<meta name="description" content="${escHtml(desc)}">
<meta name="theme-color" content="#ffffff">
<link rel="canonical" href="${escHtml(url)}">
<link rel="icon" href="../AFNJP.jpg" type="image/jpeg">
<link rel="alternate" type="application/rss+xml" title="AI Frontier News JP の最新記事" href="../feed.xml">
<meta property="og:type" content="article">
<meta property="og:site_name" content="AI Frontier News JP">
<meta property="og:title" content="${escHtml(post.title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${escHtml(url)}">
<meta property="og:image" content="${escHtml(ogImage)}">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@AI_FrontierNews">
<meta name="twitter:title" content="${escHtml(post.title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${escHtml(ogImage)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=JetBrains+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/article.css">
<script type="application/ld+json">
${ld}
</script>
</head>

<body>
${siteHeader(1)}

<div class="wrap">
    <p class="crumb">
        <a href="../index.html">トップ</a><span>/</span><a href="../archive.html">記事一覧</a><span>/</span>${escHtml(post.category || '記事')}
    </p>

    <article class="art">
        <p class="tag">#${escHtml(post.channel)}</p>
        <h1>${escHtml(post.title)}</h1>
        ${isoStr && shownDate
            ? `<p class="when"><time datetime="${escHtml(isoStr)}">${escHtml(shownDate)}</time></p>`
            : ''}

        ${cover ? `<div class="cover"><img src="../${escHtml(cover)}" alt="" width="640" height="360"></div>` : ''}

        ${lead ? `<p class="lead">${escHtml(lead)}</p>` : ''}

        ${headings.length ? `<section class="points">
            <h2>記事で取り上げている点</h2>
            <ul>
${headings.map(h => `                <li>${escHtml(h)}</li>`).join('\n')}
            </ul>
        </section>` : ''}

        ${source ? `<p class="src">
            <b>一次情報（出典）</b>
            <a href="${escHtml(source)}" target="_blank" rel="noopener noreferrer nofollow">${escHtml(post.source_label || source)}</a>
        </p>` : ''}

        <div class="cta">
            <p>記事の全文と、この話題についてのやり取りは Discord にあります。</p>
            <a class="btn" href="${escHtml(discord || DISCORD_INVITE)}" target="_blank" rel="noopener noreferrer">Discordで全文を読む</a>
            <p class="sub">参加は無料。読むだけの参加も歓迎です。</p>
        </div>
    </article>
</div>

${siteFooter(1)}
</body>

</html>
`;
}

/** 記事アーカイブの一覧ページ。月ごとに区切って全記事を並べる */
function archiveHtml(posts) {
    const url = `${SITE}archive.html`;
    const desc = `AI Frontier News JP がこれまでに配信したAIニュース記事の一覧。全${posts.length}本を月ごとに掲載しています。`;

    // 月ごとにまとめる。posts は日付の降順で渡ってくる前提。
    const months = [];
    for (const p of posts) {
        const key = jstMonthKey(p.date);
        if (!key) continue;
        if (months.at(-1)?.key !== key) months.push({ key, label: jstMonth(p.date), items: [] });
        months.at(-1).items.push(p);
    }

    const sections = months.map(mo => {
        const rows = mo.items.map(p => {
            const id = safeId(p.id);
            if (!id) return null;
            const d = jstDate(p.date);
            const isoStr = new Date(p.date);
            return `        <li><a href="posts/${id}.html">`
                + (d && !Number.isNaN(isoStr.getTime())
                    ? `<time datetime="${escHtml(isoStr.toISOString())}">${escHtml(d)}</time>` : '')
                + `<span class="t">${escHtml(p.title)}</span>`
                + `<span class="c">${escHtml(p.category || '')}</span>`
                + `</a></li>`;
        }).filter(Boolean);
        if (!rows.length) return null;
        return `    <h2>${escHtml(mo.label)}</h2>\n    <ol>\n${rows.join('\n')}\n    </ol>`;
    }).filter(Boolean);

    const ld = jsonLd({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: '記事一覧 | AI Frontier News JP',
        description: desc,
        url,
        inLanguage: 'ja-JP',
        isPartOf: { '@id': `${SITE}#org` },
    });

    return `<!DOCTYPE html>
<html lang="ja">

<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>記事一覧 | AI Frontier News JP</title>
<meta name="description" content="${escHtml(desc)}">
<meta name="theme-color" content="#ffffff">
<link rel="canonical" href="${url}">
<link rel="icon" href="AFNJP.jpg" type="image/jpeg">
<link rel="alternate" type="application/rss+xml" title="AI Frontier News JP の最新記事" href="feed.xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AI Frontier News JP">
<meta property="og:title" content="記事一覧 | AI Frontier News JP">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}AFNJP.jpg">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@AI_FrontierNews">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=JetBrains+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/article.css">
<script type="application/ld+json">
${ld}
</script>
</head>

<body>
${siteHeader(0)}

<div class="wrap">
    <p class="crumb"><a href="index.html">トップ</a><span>/</span>記事一覧</p>

    <main class="arc">
    <h1>記事一覧</h1>
    <p class="note">これまでに配信した記事 ${posts.length} 本。新しいものから順に並んでいます。</p>
${sections.join('\n')}
    </main>
</div>

${siteFooter(0)}
</body>

</html>
`;
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

function buildSitemap(latestIso, archived) {
    // lastmod は「自動生成処理が把握できる範囲での最終更新日」。
    // 厳密なページ最終更新日ではない（FAQ や説明文の手直しはここに現れない）。
    // 実行時刻を書くと毎時更新になり、Google に lastmod ごと無視されるため使わない。
    //
    // sitemap の lastmod は W3C Datetime 形式で、ミリ秒は許容されない。
    // toISOString() の "2026-08-04T14:12:10.731Z" をそのまま書くと
    // Google に「サイトマップを読み込めませんでした」と弾かれるため、
    // 秒までに丸めた "2026-08-04T14:12:10Z" にする。
    const w3c = iso => {
        const t = new Date(iso);
        return Number.isNaN(t.getTime()) ? null : t.toISOString().replace(/\.\d{3}Z$/, 'Z');
    };
    const lastmod = latestIso ? w3c(latestIso) : null;

    const entry = (loc, mod) => [
        '  <url>',
        `    <loc>${escXml(loc)}</loc>`,
        mod ? `    <lastmod>${mod}</lastmod>` : null,
        '  </url>',
    ].filter(v => v !== null).join('\n');

    // 記事ページは公開後に書き換わらないので、lastmod には記事の投稿日を入れる。
    const articles = archived
        .map(p => {
            const id = safeId(p.id);
            return id ? entry(`${SITE}posts/${id}.html`, w3c(p.date)) : null;
        })
        .filter(Boolean);

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        entry(SITE, lastmod),
        entry(`${SITE}archive.html`, lastmod),
        ...articles,
        '</urlset>',
        '',
    ].join('\n');
}

/* ═══════════ 本体 ═══════════ */

const [srcHtml, postsData, channelsData, archiveData] = await Promise.all([
    readFile(INDEX, 'utf8'),
    readFile(POSTS_JSON, 'utf8').then(JSON.parse),
    readFile(CHANNELS_JSON, 'utf8').then(JSON.parse),
    // アーカイブはまだ存在しないことがある（初回実行時）。その場合は posts.json で代用する。
    readFile(ARCHIVE_JSON, 'utf8').then(JSON.parse).catch(() => null),
]);

const allPosts = Array.isArray(postsData.posts) ? postsData.posts : [];
const groups = Array.isArray(channelsData.groups) ? channelsData.groups : [];

/** 記事ページ / アーカイブ / sitemap の元になる全記事（日付の降順） */
const archived = (Array.isArray(archiveData?.posts) && archiveData.posts.length
    ? archiveData.posts
    : allPosts
).filter(p => safeId(p.id)).sort((a, b) => new Date(b.date) - new Date(a.date));

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

/* 記事一覧への導線。累計本数を出すことで「積み上がっている」ことが一目で分かる */
const archiveLink = `<a class="btn btn-o" href="archive.html"><span>これまでの記事 ${archived.length} 本をすべて見る</span></a>`;
const ARCHIVE_PAD = ' '.repeat(20);

let outHtml;
try {
    outHtml = replaceMarkerBlock(srcHtml, 'POSTS',
        '\n' + indent(cards.join('\n'), PAD) + '\n' + PAD);
    outHtml = replaceMarkerBlock(outHtml, 'CHANNELS',
        '\n' + indent(groupBlocks.join('\n'), PAD) + '\n' + PAD);
    outHtml = replaceMarkerBlock(outHtml, 'ARCHIVE',
        '\n' + ARCHIVE_PAD + archiveLink + '\n' + ARCHIVE_PAD);
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

for (const name of ['POSTS', 'CHANNELS', 'ARCHIVE']) {
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
const sitemapXml = buildSitemap(latestIso, archived);

/* ── 個別記事ページ / アーカイブ一覧 ── */
const articlePages = new Map(); // ファイル名 -> HTML
for (const p of archived) {
    const html = articleHtml(p);
    if (html) articlePages.set(`${safeId(p.id)}.html`, html);
}
const archivePage = archived.length ? archiveHtml(archived) : null;

if (!articlePages.size) {
    problems.push('生成できる記事ページが1件もありません');
}
if (!archivePage) {
    problems.push('アーカイブ一覧に載せる記事がありません');
}
for (const [name, html] of articlePages) {
    if (!html.trimEnd().endsWith('</html>')) problems.push(`posts/${name} が </html> で終わっていません`);
    if (countOf(html, '</html>') !== 1) problems.push(`posts/${name} の </html> が1つではありません`);
    if (hasUnsafeChars(html)) problems.push(`posts/${name} に出力してはいけない文字が残っています`);
}
if (archivePage) {
    const rows = countOf(archivePage, '<li><a href="posts/');
    if (rows !== articlePages.size) {
        problems.push(`archive.html の行数が ${rows} 件で、記事ページ ${articlePages.size} 件と一致しません`);
    }
    if (hasUnsafeChars(archivePage)) problems.push('archive.html に出力してはいけない文字が残っています');
}
{
    const locs = countOf(sitemapXml, '<loc>');
    if (locs !== articlePages.size + 2) {
        problems.push(`sitemap.xml の URL が ${locs} 件で、期待の ${articlePages.size + 2} 件と一致しません`);
    }
}

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
    [ARCHIVE_HTML, archivePage, 'archive.html'],
]) {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === content) continue;
    await writeAtomic(path, content);
    changed.push(label);
}

/* ── 記事ページ ── */
await mkdir(POSTS_DIR, { recursive: true });

let written = 0;
for (const [name, html] of articlePages) {
    const path = resolve(POSTS_DIR, name);
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === html) continue;
    await writeAtomic(path, html);
    written++;
}

// アーカイブから消えた記事のページを片付ける。
// 通常アーカイブは追記のみなので、ここが動くのは記事を意図的に取り下げたときだけ。
let removed = 0;
for (const f of await readdir(POSTS_DIR).catch(() => [])) {
    if (f.endsWith('.html') && !articlePages.has(f)) {
        await unlink(resolve(POSTS_DIR, f)).catch(() => { });
        removed++;
    }
}

console.log(`✓ 静的化: 記事カード ${cards.length} 件 / チャンネル ${channelTotal} 件`);
console.log(`✓ feed.xml: ${countOf(feedXml, '<item>')} 件（最新 ${latestIso ?? '不明'}）`);
console.log(`✓ 記事ページ: ${articlePages.size} 件（うち更新 ${written} 件`
    + (removed ? ` / 削除 ${removed} 件` : '') + '）');
console.log(`✓ sitemap.xml: ${countOf(sitemapXml, '<loc>')} URL`);
console.log(changed.length ? `✓ 更新: ${changed.join(', ')}` : '✓ 変化なし（トップとフィードは最新）');
