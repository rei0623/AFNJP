import {
  esc,
  cardHtml,
  relatedPosts,
  readingPoints,
  displayDate,
  dateKey,
  weeklyPicks,
  sourcesOf,
} from "../../assets/reader-core.js";
const SITE = "https://rei0623.github.io/AFNJP/";
const INVITE = "https://discord.gg/WUWE6Ev7yh";
export const version = "20260906-reader2";
export const dataScript = (posts, extra = {}) =>
  `<script type="application/json" id="reader-data">${JSON.stringify({
    posts,
    ...extra,
  })
    .replace(/</g, "\\u003c")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .toWellFormed()}</script>`;
export function header(base = "") {
  return `<a class="skip-link" href="#main">本文へ移動</a><header class="site-header"><div class="wrap header-inner"><a class="brand" href="${base}index.html"><img src="${base}AFNJP.jpg" alt="" width="36" height="36"><span>AFNJP<small>AI Frontier News JP</small></span></a><nav aria-label="メインナビゲーション"><a href="${base}archive.html">記事を探す</a><a href="${base}archive.html?view=saved">あとで読む</a><a class="nav-about" href="${base}index.html#about">AFNJPについて</a></nav></div></header>`;
}
export function subscriptions(base = "") {
  return `<section class="subscriptions" aria-labelledby="subs-title"><div><p class="eyebrow">STAY UP TO DATE</p><h2 id="subs-title">次のニュースも、見逃さない。</h2><p>RSS・通知・ホーム画面から、自分に合った方法で。</p></div><div class="subs-actions"><a class="button" href="${base}feed.xml">RSSで購読</a><button id="pushBtn" type="button" hidden><span id="pushLabel">通知を受け取る</span></button><button id="installBtn" type="button" hidden>ホーム画面に追加</button><p id="subsNote" class="muted" role="status"></p><details><summary>ホーム画面への追加方法</summary><p>iPhone・iPadではSafariの共有メニューから「ホーム画面に追加」。その他のブラウザではメニューの「アプリをインストール」などをご利用ください。</p></details></div></section>`;
}
export function footer(base = "") {
  return `<footer class="site-footer wrap"><p><b>AFNJP</b> — AI Frontier News JP</p><nav aria-label="フッターナビゲーション"><a href="${base}index.html">トップ</a><a href="${base}archive.html">記事一覧</a><a href="${base}feed.xml">RSS</a><a href="https://x.com/AI_FrontierNews" target="_blank" rel="noopener noreferrer">X ↗</a><a href="${INVITE}" target="_blank" rel="noopener noreferrer">Discord ↗</a></nav><p class="muted">保存・閲覧履歴はこのブラウザ内に保存されます。別の端末には同期されません。</p></footer><p class="toast" id="reader-status" role="status"></p><script type="module" src="${base}assets/reader.js?v=${version}"></script><script type="module" src="${base}assets/subscriptions.js?v=${version}"></script>`;
}
export function filters(posts) {
  const select = (key, label, values) =>
    `<label>${label}<select name="${key}"><option value="">すべて</option>${[
      ...new Set(values),
    ]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
      .join("")}</select></label>`;
  return `<form id="reader-filters" class="filter-panel" role="search" aria-label="記事を検索" hidden><label class="search-field">キーワード<input name="q" type="search" placeholder="例：Claude、動画生成、開発ツール" autocomplete="off"></label><div class="filter-selects">${select(
    "company",
    "企業",
    posts.map((p) => p.company),
  )}${select(
    "model",
    "モデル・製品",
    posts.flatMap((p) => p.models),
  )}${select(
    "topic",
    "テーマ",
    posts.flatMap((p) => p.topics),
  )}${select(
    "month",
    "掲載月",
    posts.map((p) => dateKey(p.date).slice(0, 7)),
  )}</div><div class="filter-bottom"><label>表示<select name="view"><option value="">すべての記事</option><option value="saved">あとで読む</option><option value="unread">未閲覧</option><option value="history">閲覧履歴</option><option value="new">前回の訪問以降</option></select></label><button type="reset">条件をリセット</button><p id="result-count" role="status">${posts.length}件</p></div><p class="muted" id="visit-note"></p></form>`;
}
export function weeklyBlock(posts, editorial) {
  const w = weeklyPicks(posts, editorial);
  return `<section id="record" class="weekly"><div class="section-title"><div><p class="eyebrow">WEEKLY READING</p><h2>まず読みたい、3本。</h2></div><p class="muted">${esc(w.start)} 〜 ${esc(w.end)}<br>最新掲載日から7日間のニュース</p></div><p class="muted">${editorial.weekly?.end === w.end ? "編集部のピックアップ。" : "新着から、企業が偏らないように選んでいます。"}</p><div class="news-grid">${w.posts.map((p) => cardHtml(p)).join("")}</div><p class="publication-stats">掲載記事 <b>${posts.length}本</b> · この7日間 <b>${posts.filter((p) => dateKey(p.date) >= w.start && dateKey(p.date) <= w.end).length}本</b> · 最新掲載 <b>${displayDate(posts[0]?.date)}</b></p><a class="text-link" href="archive.html">すべての記事を探す →</a></section>`;
}
function head({
  title,
  desc,
  url,
  base = "",
  image = SITE + "AFNJP.jpg",
  ld,
  type = "website",
}) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} | AI Frontier News JP</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#faf9f6"><link rel="canonical" href="${esc(url)}"><link rel="icon" href="${base}AFNJP.jpg"><link rel="alternate" type="application/rss+xml" title="AFNJPの最新記事" href="${base}feed.xml"><link rel="manifest" href="${base}manifest.webmanifest"><link rel="apple-touch-icon" href="${base}assets/icons/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AFNJP"><meta property="og:type" content="${type}"><meta property="og:site_name" content="AI Frontier News JP"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}"><meta property="og:locale" content="ja_JP"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@AI_FrontierNews"><link rel="stylesheet" href="${base}assets/reader.css?v=${version}"><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c").toWellFormed()}</script></head>`;
}
export function articlePage(post, posts) {
  const id = String(post.id);
  if (!/^\d{5,25}$/.test(id)) return null;
  const base = "../",
    url = SITE + "posts/" + id + ".html",
    sources = sourcesOf(post),
    cover = /^assets\/posts\/[A-Za-z0-9._-]+$/.test(post.cover || "")
      ? post.cover
      : null;
  const desc = String(post.lead || post.excerpt || "").slice(0, 158),
    related = relatedPosts(post, posts);
  let discord = INVITE;
  try {
    const u = new URL(post.url);
    if (
      u.protocol === "https:" &&
      [
        "discord.com",
        "canary.discord.com",
        "ptb.discord.com",
        "discordapp.com",
      ].includes(u.hostname)
    )
      discord = u.href;
  } catch {}
  const validDate = (v) =>
    v && Number.isFinite(+new Date(v)) ? new Date(v).toISOString() : null;
  const date = validDate(post.date),
    updated = validDate(post.updated_at);
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "NewsArticle",
        headline: post.title,
        description: desc,
        url,
        mainEntityOfPage: url,
        inLanguage: "ja-JP",
        ...(date ? { datePublished: date, dateModified: updated || date } : {}),
        image: [SITE + (cover || "AFNJP.jpg")],
        author: {
          "@type": "Organization",
          name: "AI Frontier News JP",
          url: SITE,
        },
        publisher: {
          "@type": "Organization",
          name: "AI Frontier News JP",
          url: SITE,
          logo: { "@type": "ImageObject", url: SITE + "AFNJP.jpg" },
        },
        citation: sources,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "トップ", item: SITE },
          {
            "@type": "ListItem",
            position: 2,
            name: "記事一覧",
            item: SITE + "archive.html",
          },
          { "@type": "ListItem", position: 3, name: post.title, item: url },
        ],
      },
    ],
  };
  return (
    head({
      title: post.title,
      desc,
      url,
      base,
      image: SITE + (cover || "AFNJP.jpg"),
      ld,
      type: "article",
    }) +
    `<body data-article-id="${id}">${header(base)}<main class="wrap" id="main"><nav class="breadcrumb" aria-label="パンくず"><a href="../index.html">トップ</a> / <a href="../archive.html">記事一覧</a> / ${esc(post.company)}</nav><article class="article"><header><p class="eyebrow"><a href="../archive.html?company=${encodeURIComponent(post.company)}">${esc(post.company)}</a> / ${esc(post.topics.join("・"))}</p><h1>${esc(post.title)}</h1><p class="article-meta">AFNJP掲載 <time datetime="${esc(date)}">${displayDate(date)}</time>${updated ? ` · 記事更新 <time datetime="${esc(updated)}">${displayDate(updated)}</time>` : ""}</p><div class="article-actions"><button data-save-id="${id}" aria-pressed="false" type="button">あとで読む ＋</button><button type="button" data-share>記事を共有</button><button type="button" data-copy>リンクをコピー</button></div></header>${cover ? `<img class="article-cover" src="../${esc(cover)}" alt="" width="640" height="360" fetchpriority="high">` : ""}<p class="article-lead">${esc(post.lead || post.excerpt || "")}</p><section class="takeaways"><p class="eyebrow">QUICK READ</p><h2>この記事の要点</h2>${
      post.summary_sections?.length
        ? post.summary_sections
            .slice(0, 3)
            .map((s) => `<h3>${esc(s.heading)}</h3><p>${esc(s.text)}</p>`)
            .join("")
        : `<p>${esc(post.excerpt || post.lead || "")}</p>${
            post.headings?.length
              ? `<h3>記事で取り上げている点</h3><ul>${post.headings
                  .slice(0, 6)
                  .map((h) => `<li>${esc(h)}</li>`)
                  .join("")}</ul>`
              : ""
          }`
    }<p class="muted">Discord掲載記事からの抜粋です。詳細・文脈は全文と出典をご確認ください。</p></section>${post.audience || post.editorial.audience ? `<section><h2>こんな人に関係するニュース</h2><p>${esc(post.audience || post.editorial.audience)}</p>${!post.audience ? '<p class="muted">編集部による読者への案内です。</p>' : ""}</section>` : ""}${post.caution ? `<section><h2>注意点・制約</h2><p>${esc(post.caution)}</p></section>` : ""}<aside class="editor-note"><p class="eyebrow">EDITOR'S NOTE</p><h2>読むときの視点</h2><p>${esc(post.editorial.commentary || readingPoints(post).join(" "))}</p><p class="muted">編集部による読み方の提案です。発表元の主張とは区別しています。</p></aside><section class="sources"><h2>出典・参考リンク</h2>${sources.length ? `<ol>${sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(new URL(u).hostname)} ↗<small>${esc(u)}</small></a></li>`).join("")}</ol>` : "<p>出典はDiscordの全文に掲載しています。</p>"}<p class="muted">日付はAFNJPへの掲載日です。発表元の公開日とは異なる場合があります。</p></section><div class="discord-cta"><p>全文と、このニュースについてのやり取り</p><a class="button" href="${esc(discord)}" target="_blank" rel="noopener noreferrer">Discordで続きを読む ↗</a><p class="muted">無料で参加できます。読むだけでも歓迎です。</p></div></article>${related.length ? `<section class="related"><div class="section-title"><h2>続けて読みたい</h2><a href="../archive.html">記事一覧 →</a></div><div class="news-grid">${related.map((p) => cardHtml(p, { base })).join("")}</div></section>` : ""}${subscriptions(base)}</main>${dataScript([post, ...related])}${footer(base)}</body></html>\n`
  );
}
export function archivePage(posts) {
  return (
    head({
      title: "記事を探す",
      desc: `全${posts.length}本のAIニュースを、企業・モデル・テーマから探せます。`,
      url: SITE + "archive.html",
      ld: {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "記事一覧 | AI Frontier News JP",
        url: SITE + "archive.html",
        inLanguage: "ja-JP",
      },
    }) +
    `<body data-page="archive">${header()}<main class="wrap" id="main"><section class="archive-intro"><p class="eyebrow">THE ARCHIVE</p><h1>知りたいAIニュースへ。</h1><p>一次情報を確認して、日本語で。全${posts.length}本の記事を探せます。</p></section>${filters(posts)}<noscript><p>新しい順に全記事を表示しています。検索・保存機能にはJavaScriptを有効にしてください。</p></noscript><div class="news-grid archive-grid" id="archive-results">${posts.map((p) => cardHtml(p)).join("")}</div><div id="empty-results" class="empty" hidden><h2>該当する記事がありません</h2><p>キーワードや絞り込み条件を変えてみてください。保存した記事は、このブラウザで確認できます。</p></div>${subscriptions()}</main>${dataScript(posts)}${footer()}</body></html>\n`
  );
}
