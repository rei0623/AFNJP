/** Shared, side-effect-free rules for generated pages and the browser. */
export const esc = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .toWellFormed()
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
export const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
export function sourceUrl(value) {
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function sourcesOf(post) {
  return [
    ...new Set(
      [
        post.source_url,
        ...(Array.isArray(post.source_urls) ? post.source_urls : []),
      ]
        .map(sourceUrl)
        .filter(Boolean),
    ),
  ];
}
export const dateKey = (value) => {
  const d = new Date(value);
  return Number.isFinite(+d)
    ? new Date(+d + 32400000).toISOString().slice(0, 10)
    : "";
};
export const displayDate = (value) => dateKey(value).replaceAll("-", ".");
const topicRules = [
  [
    "開発ツール",
    /codex|claude.?code|cursor|kotlin|sdk|\bcli\b|github|プログラミング|コーディング|開発環境|開発者/i,
  ],
  [
    "画像・動画・音声",
    /画像|映像|動画|image|video|runway|sora|lyria|音楽|音声|voice/i,
  ],
  ["研究", /研究|論文|数学|証明|定理|科学|ベンチマーク|評価|学習|推論|量子化/],
  [
    "仕事での活用",
    /業務|企業|導入|仕事|法務|医療|教育|workspace|enterprise|business|活用|市場投入/i,
  ],
  [
    "安全・社会",
    /安全|リスク|政策|法案|規制|プライバシー|攻撃|防御|サイバー|監督|ガバナンス/,
  ],
  [
    "モデル更新",
    /モデル|gpt|gemini|claude|qwen|glm|deepseek|grok|muse|リリース/i,
  ],
];
const companyRules = [
  ["OpenAI", /openai\.com|\bopen[ -]?ai\b/i],
  ["Google", /google|gemini/i],
  ["Anthropic", /anthropic|claude/i],
  ["Runway", /runway/i],
  ["DeepSeek", /deep.?seek/i],
  ["Z.ai", /z\.ai|^glm$/i],
  ["Moonshot", /moonshot|^kimi$/i],
  ["NVIDIA", /nvidia/i],
  ["Microsoft", /microsoft|copilot/i],
  ["Meta", /\bmeta\b|fb\.com/],
  ["Alibaba", /alibaba|qwen/i],
  ["Mistral", /mistral/i],
  ["Liquid AI", /liquid\.ai/i],
  ["Perplexity", /perplexity/i],
  ["Cursor", /cursor/i],
];
export function enrich(post, notes = {}) {
  const title = String(post.title || "");
  const topicText = title + " " + (post.channel || "");
  const companyText = [
    post.category,
    post.channel,
    ...sourcesOf(post).map((u) => new URL(u).hostname),
  ].join(" ");
  const company =
    notes.company ||
    companyRules.find(([, re]) => re.test(companyText))?.[0] ||
    post.category ||
    "その他";
  const topics = Array.isArray(notes.topics)
    ? notes.topics
    : topicRules.filter(([, re]) => re.test(topicText)).map(([name]) => name);
  const models = [
    ...new Set(
      [
        "ChatGPT",
        "GPT-6",
        "GPT-5.6",
        "Codex",
        "Claude Code",
        "Claude",
        "Gemini",
        "Qwen",
        "GLM",
        "DeepSeek",
        "Grok",
        "Sora",
        "Cursor",
        "Kimi",
        "Lyria",
        "NotebookLM",
        "Antigravity",
        "Suno",
      ].filter((name) => normalize(topicText).includes(normalize(name))),
    ),
  ];
  return {
    ...post,
    company,
    topics: topics.length ? topics : ["その他"],
    models,
    source_urls: sourcesOf(post),
    editorial: notes,
  };
}
export function matches(post, filters, state = {}) {
  const terms = normalize(filters.q).split(" ").filter(Boolean);
  const hay = normalize(
    [
      post.title,
      post.lead,
      post.excerpt,
      post.channel,
      post.company,
      ...post.topics,
      ...post.models,
    ].join(" "),
  );
  return (
    terms.every((term) => hay.includes(term)) &&
    (!filters.company || filters.company === post.company) &&
    (!filters.model || post.models.includes(filters.model)) &&
    (!filters.topic || post.topics.includes(filters.topic)) &&
    (!filters.month || dateKey(post.date).startsWith(filters.month)) &&
    (filters.view !== "saved" || Boolean(state.saved?.[post.id])) &&
    (filters.view !== "history" || Boolean(state.read?.[post.id])) &&
    (filters.view !== "unread" || !state.read?.[post.id]) &&
    (filters.view !== "new" ||
      Boolean(
        state.previousVisit &&
          new Date(post.first_seen || post.date).getTime() >
            state.previousVisit,
      ))
  );
}
export function relatedPosts(post, posts, limit = 3) {
  return posts
    .filter((p) => p.id !== post.id)
    .map((p) => ({
      p,
      score:
        (p.company === post.company ? 2 : 0) +
        p.topics.filter((t) => post.topics.includes(t)).length +
        p.models.filter((m) => post.models.includes(m)).length * 3,
    }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) => b.score - a.score || new Date(b.p.date) - new Date(a.p.date),
    )
    .slice(0, limit)
    .map((x) => x.p);
}
export function weeklyPicks(posts, editorial = {}) {
  if (!posts.length) return { start: "", end: "", posts: [] };
  const end = dateKey(posts[0].date);
  const start = new Date(new Date(end + "T00:00:00Z").getTime() - 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const pool = posts.filter(
    (p) => dateKey(p.date) >= start && !/リーク/.test(p.category),
  );
  const manual =
    editorial.weekly?.end === end ? editorial.weekly.ids || [] : [];
  const picks = manual
    .map((id) => pool.find((p) => p.id === id))
    .filter(Boolean)
    .slice(0, 3);
  for (const p of pool)
    if (
      picks.length < 3 &&
      !picks.includes(p) &&
      !picks.some((x) => x.company === p.company)
    )
      picks.push(p);
  for (const p of pool)
    if (picks.length < 3 && !picks.includes(p)) picks.push(p);
  return { start, end, posts: picks };
}
export function readingPoints(post) {
  const points = [];
  if (post.topics.includes("開発ツール"))
    points.push("対応環境・利用できる機能・既存の開発手順への影響を確認する。");
  if (post.topics.includes("研究"))
    points.push("研究上の結果と、日常的に利用できる機能を分けて読む。");
  if (post.topics.includes("仕事での活用"))
    points.push("対象業務・導入条件・人による確認が必要な工程を確認する。");
  if (post.topics.includes("画像・動画・音声"))
    points.push("利用範囲・提供地域・生成物の取り扱い条件を確認する。");
  return points.length
    ? points.slice(0, 2)
    : ["提供状況・対象ユーザー・利用条件を、発表元の情報で確認する。"];
}
export function cardHtml(
  post,
  { base = "", state = {}, feature = false, reason = "" } = {},
) {
  if (!/^\d{5,25}$/.test(String(post.id))) return "";
  const cover = /^assets\/posts\/[A-Za-z0-9._-]+$/.test(post.cover || "")
    ? `<img src="${base}${esc(post.cover)}" alt="" width="640" height="360" loading="${feature ? "eager" : "lazy"}"${feature ? ' fetchpriority="high"' : ""}>`
    : `<span class="cover-word">${esc(post.company)}</span>`;
  const saved = Boolean(state.saved?.[post.id]);
  return `<article class="news-card${feature ? " featured" : ""}" data-post-id="${esc(post.id)}">
        <a class="card-image" href="${base}posts/${post.id}.html" aria-hidden="true" tabindex="-1">${cover}</a>
        <div class="card-body">${feature ? `<p class="eyebrow">注目のニュース</p>` : ""}
        <p class="card-meta"><a href="${base}archive.html?company=${encodeURIComponent(post.company)}">${esc(post.company)}</a><time datetime="${esc(post.date)}">${displayDate(post.date)}</time><span class="read-label" data-read-id="${post.id}">${state.read?.[post.id] ? "閲覧済み" : ""}</span></p>
        <h3><a data-article-link href="${base}posts/${post.id}.html">${esc(post.title)}</a></h3>
        <p class="card-excerpt">${esc(post.excerpt || post.lead || "")}</p>
        ${feature && reason ? `<p class="pick-reason">選んだ理由：${esc(reason)}</p>` : ""}
        <div class="card-bottom"><span>${esc(post.topics.slice(0, 2).join(" / "))}</span><button type="button" data-save-id="${post.id}" aria-label="${esc(post.title)}をあとで読む" aria-pressed="${saved}">${saved ? "保存済み ✓" : "あとで読む ＋"}</button></div></div>
    </article>`.replace(/[\t ]+$/gm, "");
}
