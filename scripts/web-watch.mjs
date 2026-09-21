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
 *   posts-archive.json の source_url / source_urls と突き合わせ、
 *   AFNJP で既に記事化したかを示す。検知の時点ではまず未記事化なので、
 *   このチャンネルが「まだ書いていない発表」の一覧として機能する。
 *
 *   URL が一致しなかったものは Jev に「同じ発表を書いた記事がアーカイブにあるか」を問う。
 *   同じ発表が deepmind.google と blog.google のように別ドメインで出ても拾えるようにするため。
 *   確信が持てないものは 🟡 として記事リンクを添えるだけにとどめ、🔴 から勝手に外さない。
 *   外すと「まだ書いていない発表」がこの一覧から消えてしまうので、迷ったら人に見せる側へ倒す。
 *
 *   ついでに重要度・AI関連か・噂か・国内関連かも同じ呼び出しで取り、
 *   🔥 / 🔇 / 🗣 の目印を付ける。投稿自体は止めない（取りこぼさないため）。
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN … Bot トークン（投稿先チャンネルへの「メッセージを送信」権限が必要）
 *   WATCH_CHANNEL_ID  … 投稿先チャンネルID（省略時は #一次情報ウォッチ）
 *   PUSH_SEND_TOKEN   … Worker の /watch/state を読み書きするための合言葉
 *   TYPESAFE_API_KEY  … 任意。無ければ Jev の判断は行わず、従来どおりの表示になる
 *
 * DISCORD_BOT_TOKEN / PUSH_SEND_TOKEN が欠けているときは何もせず正常終了する。
 *
 * 使い方:
 *   DISCORD_BOT_TOKEN=xxx PUSH_SEND_TOKEN=yyy node scripts/web-watch.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as jev from './lib/jev.mjs';

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
 * Discord API 用の User-Agent。
 * 上のクローラー用UAを使い回すと 403（code 40333）で弾かれる。
 * Discord は Bot に "DiscordBot (URL, version)" の形式を求めている。
 */
const DISCORD_UA = 'DiscordBot (https://github.com/rei0623/AFNJP, 1.0)';

/**
 * --dry-run … 状態も Discord も触らず、各ソースから何件取れるかだけを見る。
 * 監視先を足したときに、その定義が正しいかを手元で確かめるためのもの。
 */
const DRY = process.argv.includes('--dry-run');

/**
 * --ping … 投稿先チャンネルへテスト投稿を1件だけ出す。
 * Bot の権限（チャンネルを見る / メッセージを送信）が付いているかを、
 * 実際の新着を待たずに確かめるためのもの。状態には触らない。
 */
const PING = process.argv.includes('--ping');

/**
 * --preview … 各社の最新1件を、実際の投稿と同じ見た目で出す。
 * 状態には触らないので、何度実行しても本番の検知には影響しない。
 * 見た目を変えたいときの確認用。
 */
const PREVIEW = process.argv.includes('--preview');

/**
 * --volume … 各ソースが直近7日で何件出しているかを数える。
 * 監視先を増やすと通知が増えるので、入れる前に流量を見るためのもの。
 */
const VOLUME = process.argv.includes('--volume');

/**
 * --judge … Jev の「同じ発表か」の判定が実際に当たるかを、答えが分かっている
 * 材料で測る。アーカイブの新しい記事の出典URLを「いま検知した新着」に見立て、
 * URL 一致を使わずに、その記事自身を見つけられるかを見る。
 * 見出しは出典ページから実際に取ってくる（本番と同じ、発表元の英語見出しで測るため。
 * AFNJP 側の日本語タイトルを使うと当たって当然になり、測る意味がなくなる）。
 * Discord にも状態にも触らない。
 */
const JUDGE = process.argv.includes('--judge');

/** 取得して数えるだけのモードは、トークンも状態も要らない */
const OFFLINE = DRY || VOLUME || JUDGE;

if (!OFFLINE && !TOKEN) {
    console.log('… DISCORD_BOT_TOKEN が未設定のため、監視をスキップします。');
    process.exit(0);
}
if (!OFFLINE && !STATE_TOKEN) {
    console.log('… PUSH_SEND_TOKEN が未設定のため、監視をスキップします。');
    process.exit(0);
}

const config = await readFile(CONFIG, 'utf8').then(JSON.parse).catch(() => null);
if (!OFFLINE && !config?.endpoint) {
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
        if (title && link) out.push({ title, url: link, date, dateKind: 'published' });
    }
    return out;
}

/* ═══════════ アダプタ: sitemap ═══════════ */

const locsOf = xml => [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => unescapeXml(m[1]));

/**
 * <url> ごとに loc と lastmod を取り出す。
 * lastmod は「最終更新日」であって公開日ではない。サイト全体の再ビルドで
 * 全URLが同じ日時になるところもある（Runway など）ので、表示ではそう断る。
 */
function entriesOf(xml) {
    const out = [];
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
        const block = m[1];
        const loc = block.match(/<loc>([\s\S]*?)<\/loc>/i);
        if (!loc) continue;
        const mod = block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i);
        out.push({ url: unescapeXml(loc[1]), lastmod: mod ? unescapeXml(mod[1]) : null });
    }
    // <url> で囲まれていない書き方にも一応備える
    if (!out.length) return locsOf(xml).map(url => ({ url, lastmod: null }));
    return out;
}

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
                urls.push(...entriesOf(sub));
            } catch { /* 一部が落ちても他は続ける */ }
        }
    } else {
        urls = entriesOf(xml);
    }

    const include = source.include ? new RegExp(source.include) : null;
    const seen = new Set();
    const out = [];
    for (const e of urls) {
        let path;
        try {
            path = new URL(e.url).pathname.replace(/\/$/, '');
        } catch {
            continue;
        }
        if (include && !include.test(path)) continue;
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        // sitemap から分かるのは更新日まで。公開日とは限らないので印を付ける
        out.push({ title: null, url: e.url, date: e.lastmod, dateKind: 'lastmod' });
    }
    // 新しい順に並べ替える。sitemap は多くがアルファベット順なので、
    // 並べ替えないと「最新」を選んだつもりで古い記事を掴む
    out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
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
const archivePosts = archive?.posts || [];

/*
 * URL の完全一致で分かるぶん。sync-discord.mjs が参考文献の全URLを
 * source_urls に入れるようになったので、代表の1本だけでなく全部を突き合わせる。
 * 同じ発表を別ドメインで検知しても、記事が両方を参考文献に挙げていれば
 * ここで一致する（Jev を呼ばずに済む＝課金も発生しない）。
 */
const coveredBy = new Map();   // 正規化URL → その発表を書いた記事
for (const p of archivePosts) {
    for (const u of [p.source_url, ...(p.source_urls || [])].filter(Boolean)) {
        const k = normalize(u);
        if (!coveredBy.has(k)) coveredBy.set(k, p);
    }
}
const covered = { has: u => coveredBy.has(u) };

/* ═══════════ Jev による判断（TYPESAFE_API_KEY が無ければ全部スキップ） ═══════════
 *
 * ここで任せるのは2つだけ。
 *
 *   1. URL が一致しなかった新着について、アーカイブの中に
 *      「同じ発表を書いた記事」があるか
 *   2. その発表が読者にとってどれくらい重要か（＝拾う価値があるか）
 *
 * どちらも同じ state（新着1件＋候補記事）に対する独立した問いなので、
 * 1回の呼び出しにまとめる。分けると同じ state を二重に課金することになる。
 *
 * 呼ぶのは「実際に投稿する新着」だけ。MAX_POST_PER_RUN（12件）が
 * そのまま1回の実行あたりのリクエスト上限になる。
 */

/** 候補を探す時間窓。発表から記事になるまでの実運用のずれを見込む */
const CANDIDATE_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** 1件の新着につき Jev に見せる候補記事の数。増やすほど state が伸びる */
const MAX_CANDIDATES = 5;

/** 比較用に単語へ割る。日本語は2文字ずつ、英数字は語単位 */
function tokens(s = '') {
    const t = String(s).toLowerCase();
    const words = t.match(/[a-z0-9][a-z0-9.+-]{1,}/g) || [];
    const kana = t.match(/[ぁ-んァ-ヶ一-龠]{2,}/g) || [];
    const bigrams = kana.flatMap(w =>
        Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)));
    return new Set([...words, ...bigrams]);
}

/**
 * Jev に見せる候補をコード側で絞る。
 * ここを雑にすると state が伸びて課金だけ増えるので、
 * 「日付が近い」かつ「語が重なる」ものだけを上位数件に落とす。
 */
function candidatesFor(item) {
    const at = item.date ? new Date(item.date).getTime() : Date.now();
    const base = Number.isNaN(at) ? Date.now() : at;
    const host = (() => { try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const want = tokens(item.title || item.url);

    return archivePosts
        .filter(p => Math.abs(new Date(p.date).getTime() - base) <= CANDIDATE_WINDOW_MS)
        .map(p => {
            const have = tokens(p.title);
            let overlap = 0;
            for (const w of want) if (have.has(w)) overlap++;
            // 同じドメインの出典を持つ記事は、それだけで有力
            const sameHost = [p.source_url, ...(p.source_urls || [])]
                .some(u => u && normalize(u).startsWith(host));
            return { p, rank: overlap + (sameHost ? 3 : 0) };
        })
        .filter(c => c.rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, MAX_CANDIDATES)
        .map(c => c.p);
}

/*
 * 以下の閾値は `node scripts/web-watch.mjs --judge 30` で実データを測って決めた。
 * アーカイブの記事30件を「新着」に見立てた結果は
 *   正解 29 / 見つけられず 1 / 別の記事を選んだ 0
 * で、正解した一致確率は 0.66〜0.96 に収まっていた。
 * 監視先や記事の傾向が変わったら、同じコマンドで測り直すこと。
 */

/** 「同じ発表か」の判定をこの確率から上に見なす。下回ったら未記事化のまま出す */
const SAME_ANNOUNCEMENT_MIN = 0.55;
/** ここを超えたら、まず間違いないと言える線 */
const SAME_ANNOUNCEMENT_SURE = 0.80;

/*
 * 重要度の実分布は 0.3〜2.1（中央値 1.3）だった。
 * 公式ブログの新着はほとんどが製品の通常アップデートなので、
 * 上の段階（「その日のトップ級」以上）はめったに出ない。これは妥当な結果。
 * 4.0 を基準に閾値を置くと 🔥 が一生点かないので、実分布に合わせてある。
 */
const IMPORTANT_MIN = 1.9;
const MINOR_MAX = 0.7;

/**
 * 新着1件について、必要な判断をまとめて取る。
 * 取れなければ null（＝従来どおりの表示に落ちる）。
 */
async function judge(item, source) {
    if (!jev.enabled) return null;

    const cands = candidatesFor(item);
    const options = Object.fromEntries(cands.map((p, i) => [
        `a${i}`,
        `${p.title}（${new Date(p.date).toISOString().slice(0, 10)} / 出典 ${p.source_label || '不明'}）`,
    ]));

    const questions = {
        importance: jev.score(
            'この発表が、AIを日常的に追っている日本語読者にとってどれくらい重要か。'
            + '`news.title` の内容で判断する',
            [
                '些末。製品の細かな更新や告知で、知らなくても何も困らない',
                '業界の人なら知っておいてもよい程度',
                '多くの読者が知りたい。記事にする価値が十分にある',
                '重要。その日のトップに置くべき発表',
                '極めて重要。業界の前提が変わるレベルの発表',
            ],
        ),
        is_ai_news: jev.noul('AI に関する発表・記事である', {
            true: 'AIのモデル・製品・研究・企業動向・規制に関する内容',
            false: '採用情報、イベント告知、法務・規約の更新、AIと無関係な製品の話',
        }),
        is_rumor: jev.noul('未発表の製品に関するリーク・噂・観測にすぎない', {
            true: '「〜らしい」「関係者によると」など、公式に確認されていない情報',
            false: '公式に発表・確認された事実',
        }),
        japan_relevant: jev.noul(
            '日本の読者に固有の関連性がある（国内企業・日本語対応・国内の規制など）'),
    };

    // 候補が1件も無いなら、この問いは立てない（state を無駄に伸ばさない）
    if (cands.length) {
        questions.same_as = jev.choice(
            {
                question: '`news` と同じ発表について書かれた記事が、'
                    + '選択肢（AFNJP が既に公開した記事）の中にあるか。'
                    + '同じ出来事を報じていれば、見出しの言い回しや参照しているURLが違っても「同じ発表」とみなす。'
                    + '関連はするが別の出来事（別のモデル、別の日の発表、続報ではない独立した話題）は「なし」を選ぶ',
            },
            { ...options, none: 'この発表について書かれた記事は、選択肢の中に無い' },
        );
    }

    const answers = await jev.ask({
        news: {
            title: item.title || item.url,
            url: item.url,
            publisher: source.label,
            date: item.date || null,
        },
    }, questions);
    if (!answers) return null;

    // same_as の答えを記事オブジェクトに戻す。確率は none 以外の合計で見る
    let match = null, matchP = 0;
    const sa = answers.same_as;
    if (sa && sa.choice !== 'none') {
        const i = Number(String(sa.choice).slice(1));
        match = cands[i] || null;
        matchP = sa.probabilities?.[sa.choice] ?? 0;
    }

    return {
        importance: answers.importance?.score ?? null,
        importanceConfidence: answers.importance?.confidence ?? 0,
        isAiNews: answers.is_ai_news?.noul ?? 1,
        isRumor: answers.is_rumor?.noul ?? 0,
        japanRelevant: answers.japan_relevant?.noul ?? 0,
        match,
        matchP,
    };
}

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

/** 投稿ずみメッセージの埋め込みを差し替える。🔴 を ✅ に変えるのに使う */
async function editDiscord(messageId, embeds) {
    const res = await fetch(
        `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': DISCORD_UA,
        },
        body: JSON.stringify({ embeds }),
    });
    if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 2);
        await new Promise(r => setTimeout(r, retry * 1000 + 250));
        return editDiscord(messageId, embeds);
    }
    // 消されたメッセージは 404。追いかける意味がないので呼び出し側で捨てる
    if (!res.ok) throw new Error(`Discord ${res.status} — ${await res.text()}`);
    return res.json();
}

async function postToDiscord(embeds) {
    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': DISCORD_UA,
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

const MARK_TODO = '🔴 未記事化';
const MARK_DONE = '✅ AFNJP で記事化ずみ';
/** URL は一致しないが、Jev が「同じ発表の記事がある」と見たとき */
const MARK_MAYBE = '🟡 記事化ずみかもしれない';

/** 「12分前」のような相対表記。検知の速さを毎回見えるようにするためのもの */
function ago(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '1分以内';
    if (m < 60) return `${m}分前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}時間前`;
    return `${Math.round(h / 24)}日前`;
}

/**
 * Jev の判断を1行の見出しにする。
 *
 * 方針はここ（コード側）が持つ。モデルに「載せるべきか」は聞いていない。
 * 生の判断を残しておけば、基準を変えても推論をやり直す必要がない。
 */
function verdictOf(j) {
    if (!j) return { badge: null, note: null };

    // AIの話ですらないもの。sitemap 由来のソースで採用情報や規約更新を拾ったとき
    if (j.isAiNews < 0.4) {
        return { badge: '🔇', note: `AI以外の内容に見える（AI関連 ${(j.isAiNews * 100).toFixed(0)}%）` };
    }
    if (j.isRumor > 0.6) {
        return { badge: '🗣', note: `噂・観測の可能性（${(j.isRumor * 100).toFixed(0)}%）` };
    }
    if (j.importance !== null && j.importance >= IMPORTANT_MIN) {
        const extra = j.japanRelevant > 0.7 ? '・国内向けの切り口あり' : '';
        return { badge: '🔥', note: `重要度 ${j.importance.toFixed(1)}/4${extra}` };
    }
    if (j.importance !== null && j.importance < MINOR_MAX) {
        return { badge: '🔈', note: `重要度 ${j.importance.toFixed(1)}/4` };
    }
    return {
        badge: null,
        note: j.japanRelevant > 0.7 ? '国内向けの切り口あり' : null,
    };
}

function embedOf(item, source, isCovered = covered.has(normalize(item.url)), j = null) {
    const when = item.date ? new Date(item.date) : null;
    const valid = when && !Number.isNaN(when.getTime());

    /*
     * フッターに「何を基準にした時刻か」と「そこからの経過」を出す。
     *   published … フィードの公開日時。検知の遅れがそのまま読める
     *   lastmod   … sitemap の最終更新日。公開日とは限らないので断る
     *   なし      … 日付が取れないので検知時刻
     */
    let stamp;
    if (valid && item.dateKind === 'published') {
        stamp = `公開から ${ago(Date.now() - when.getTime())}`;
    } else if (valid && item.dateKind === 'lastmod') {
        stamp = `更新から ${ago(Date.now() - when.getTime())}（公開日は不明）`;
    } else {
        stamp = '公開日は不明（検知時刻を表示）';
    }

    const { badge, note } = verdictOf(j);

    /*
     * 記事化ずみの表示は3段階。
     *   ✅ URL が一致した（確実）
     *   🟡 URL は違うが、Jev が同じ発表の記事を見つけた（要確認・記事リンクを添える）
     *   🔴 見つからなかった
     * 🟡 を ✅ と同じ扱いにしないのは、ここを外すと
     * 「まだ書いていない発表の一覧」から発表が消えてしまうため。
     * 迷ったら人に見せる側へ倒す。
     */
    let description;
    if (isCovered) {
        description = MARK_DONE;
    } else if (j?.match && j.matchP >= SAME_ANNOUNCEMENT_MIN) {
        const sure = j.matchP >= SAME_ANNOUNCEMENT_SURE ? '' : '（確信度は低め）';
        description = `${MARK_MAYBE}${sure}\n→ [${j.match.title}](${j.match.url})`;
    } else {
        description = MARK_TODO;
    }
    if (note) description += `\n${note}`;

    return {
        author: { name: source.label },
        title: `${badge ? badge + ' ' : ''}${item.title || item.url}`.slice(0, 250),
        url: item.url,
        description,
        color: COLOR[source.category] ?? COLOR['その他'],
        timestamp: valid ? when.toISOString() : new Date().toISOString(),
        footer: { text: `${source.category} · ${stamp}` },
    };
}

/* ═══════════ 本処理 ═══════════ */

const { sources } = JSON.parse(await readFile(SOURCES, 'utf8'));

if (JUDGE) {
    if (!jev.enabled) {
        console.log('… TYPESAFE_API_KEY が未設定です。判定を測るにはこの鍵が要ります。');
        process.exit(0);
    }

    const n = Number(process.argv[process.argv.indexOf('--judge') + 1]) || 10;
    const samples = archivePosts.filter(p => p.source_url).slice(0, n);
    if (!samples.length) {
        console.log('… 出典URLを持つ記事がアーカイブにありません。');
        process.exit(0);
    }

    console.log(`アーカイブの新しい ${samples.length} 件を「新着」に見立てて、`
        + `その記事自身を見つけられるか測ります。\n`);

    let hit = 0, miss = 0, wrong = 0;
    for (const post of samples) {
        // 本番と同じ材料にするため、見出しは出典ページから取る
        const title = await titleOf(post.source_url);
        const item = { title, url: post.source_url, date: post.date };
        const j = await judge(item, { label: post.source_label || '不明' });

        const ok = j?.match?.id === post.id && j.matchP >= SAME_ANNOUNCEMENT_MIN;
        const picked = j?.match && j.matchP >= SAME_ANNOUNCEMENT_MIN ? j.match : null;

        if (ok) hit++;
        else if (!picked) miss++;
        else wrong++;

        console.log(`${ok ? '✓' : picked ? '✗' : '−'} ${(title || post.source_url).slice(0, 64)}`);
        console.log(`    正解: ${post.title.slice(0, 60)}`);
        if (picked && !ok) console.log(`    選んだ: ${picked.title.slice(0, 60)}`);
        console.log(`    一致確率 ${(j?.matchP ?? 0).toFixed(2)}`
            + `  重要度 ${j?.importance?.toFixed(1) ?? '−'}/4`
            + `  AI関連 ${((j?.isAiNews ?? 0) * 100).toFixed(0)}%`
            + `  噂 ${((j?.isRumor ?? 0) * 100).toFixed(0)}%`);
    }

    console.log(`\n正解 ${hit} / 見つけられず ${miss} / 別の記事を選んだ ${wrong}`
        + `  （${samples.length} 件中）`);
    console.log(jev.usageLine());
    console.log('\n「見つけられず」は 🔴 未記事化のまま出るだけなので、従来と同じ挙動です。'
        + '\n「別の記事を選んだ」が多いなら SAME_ANNOUNCEMENT_MIN を上げてください。');
    process.exit(0);
}

if (PING) {
    try {
        await postToDiscord([{
            author: { name: '一次情報ウォッチ' },
            title: '疎通確認',
            description: 'Bot からこのチャンネルへ投稿できています。\n'
                + `監視対象は ${sources.length} ソースです。`,
            color: 0x4285f4,
            timestamp: new Date().toISOString(),
            footer: { text: 'このメッセージは消して構いません' },
        }]);
        console.log('✓ 投稿できました。権限は足りています。');
    } catch (e) {
        console.error(`✗ 投稿できませんでした: ${e.message}`);
        console.error('   Bot がチャンネルに追加され、「メッセージを送信」が許可されているか確認してください。');
        process.exit(1);
    }
    process.exit(0);
}

if (VOLUME) {
    const WINDOW_DAYS = 7;
    const since = Date.now() - WINDOW_DAYS * 86400000;

    const rows = await Promise.all(sources.map(async source => {
        try {
            const items = source.type === 'rss'
                ? parseFeed(await get(source.url, 'application/rss+xml,application/xml,text/xml'))
                : await readSitemap(source);
            const dated = items.filter(i => i.date && !Number.isNaN(new Date(i.date).getTime()));
            const recent = dated.filter(i => new Date(i.date).getTime() >= since).length;
            return {
                source,
                perDay: dated.length ? recent / WINDOW_DAYS : null,
                total: items.length,
                dated: dated.length,
            };
        } catch (e) {
            return { source, error: e.message };
        }
    }));

    /*
     * rss は公開日なので信用できる。
     * sitemap の lastmod はサイト全体の一斉更新で動くことがあり、
     * 「その日に出た記事の数」にはならない。実際の検知はURLの差分で行うので、
     * ここの数字ほどは通知されない。数え方が違うものを足しても意味がないため分けて出す。
     */
    let sumRss = 0, sumSitemap = 0;
    const show = kind => {
        for (const r of rows
            .filter(x => x.source.type === kind)
            .sort((a, b) => (b.perDay ?? -1) - (a.perDay ?? -1))) {
            if (r.error) {
                console.log(`   ?      ${r.source.label.padEnd(24)} 取得失敗: ${r.error}`);
                continue;
            }
            if (r.perDay === null) {
                console.log(`   ?      ${r.source.label.padEnd(24)} 日付が取れません（全${r.total}件）`);
                continue;
            }
            if (kind === 'rss') sumRss += r.perDay; else sumSitemap += r.perDay;
            const bar = '█'.repeat(Math.min(24, Math.round(r.perDay * 2)));
            console.log(`  ${r.perDay.toFixed(1).padStart(5)}/日  ${r.source.label.padEnd(24)} ${bar}`);
        }
    };

    console.log('── RSS（公開日が取れるので信用できる） ──');
    show('rss');
    console.log('\n── sitemap（lastmod は一斉更新で動くため、あくまで参考値） ──');
    show('sitemap');

    console.log(`\n実際に近いのは RSS 側の およそ ${sumRss.toFixed(1)} 件/日。`);
    console.log(`sitemap 側は ${sumSitemap.toFixed(1)} 件/日と出るが、これは水増しされている。`);
    console.log('検知はURLの差分で行うので、通知量はこの合計より少なくなる。');
    process.exit(0);
}

if (PREVIEW) {
    // 見た目の確認用。各社の最新1件を、本番と同じ組み立てで出す。
    const picks = [];
    for (const source of sources.slice(0, 6)) {
        try {
            const items = source.type === 'rss'
                ? parseFeed(await get(source.url, 'application/rss+xml,application/xml,text/xml'))
                : await readSitemap(source);
            const item = items[0];
            if (!item) continue;
            if (!item.title) item.title = await titleOf(item.url);
            picks.push({ item, source });
        } catch { /* 取れないソースは飛ばす */ }
    }
    if (!picks.length) {
        console.error('✗ サンプルを1件も取得できませんでした。');
        process.exit(1);
    }
    await postToDiscord(picks.map(p => embedOf(p.item, p.source)));
    console.log(`✓ サンプル ${picks.length} 件を投稿しました（状態は変更していません）。`);
    process.exit(0);
}

const state = DRY ? {} : await loadState();

/* ═══════════ 記事化ずみになったものを ✅ に直す ═══════════
   投稿は一度きりなので、あとで記事を書いても 🔴 のまま残ってしまう。
   未記事化で出したものを覚えておき、毎回アーカイブと突き合わせて書き換える。
   posts-archive.json の更新が毎時なので、✅ になるまで最大1時間ほどかかる。 */

/** 45日たっても記事化されなかったものは追跡をやめる（見送った発表とみなす） */
const PENDING_TTL_MS = 45 * 24 * 3600 * 1000;

state._pending ??= {};
const pending = state._pending;

let fixed = 0, dropped = 0;
for (const [messageId, entry] of (DRY ? [] : Object.entries(pending))) {
    const age = Date.now() - new Date(entry.at || 0).getTime();
    if (!entry.url || Number.isNaN(age) || age > PENDING_TTL_MS) {
        delete pending[messageId];
        dropped++;
        continue;
    }
    if (!covered.has(normalize(entry.url))) continue;

    try {
        await editDiscord(messageId, [{ ...entry.embed, description: MARK_DONE }]);
        fixed++;
    } catch (e) {
        // 404（消された）なら追う意味がないので捨てる。それ以外は次回に再試行する
        if (/Discord 404/.test(e.message)) dropped++;
        else continue;
    }
    delete pending[messageId];
}
if (fixed || dropped) {
    console.log(`✓ 記事化ずみに更新: ${fixed} 件`
        + (dropped ? `（追跡をやめたもの ${dropped} 件）` : ''));
}

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

    for (const item of fresh) found.push({ item, source });

    // ここでは既読にしない。実際に投稿できたものだけを、あとでまとめて既読にする。
    // 先に既読へ入れてしまうと、投稿に失敗したぶんや上限で溢れたぶんが
    // 二度と流れてこなくなる（発表を取りこぼす）。
}));

if (seeded) {
    console.log(`✓ 初回セットアップ: ${seeded} ソースの現在の記事を既読として登録しました。`);
}
for (const e of errors) console.warn(`  … ${e}`);

if (!found.length) {
    // 新着が無くても、初回登録や ✅ への更新で state が変わっていれば保存する
    if (seeded || fixed || dropped) await saveState(state);
    console.log(`✓ 新着なし（監視 ${sources.length} ソース / 失敗 ${errors.length}）`);
    process.exit(0);
}

// 新しい順に並べ、1回の投稿数に上限をかける。
// 溢れたぶんは既読にしないので、次の実行（5分後）に持ち越される。
found.sort((a, b) => new Date(b.item.date || 0) - new Date(a.item.date || 0));
const targets = found.slice(0, MAX_POST_PER_RUN);
if (found.length > targets.length) {
    console.log(`  … 新着 ${found.length} 件のうち ${targets.length} 件を投稿します（残りは次回）`);
}

// sitemap 由来はタイトルが無いので、投稿するぶんだけ取りに行く
for (const t of targets) {
    if (!t.item.title) t.item.title = await titleOf(t.item.url);
}

/*
 * Jev に問うのは「投稿するぶん」だけ、かつ「URL で記事化ずみと分からなかったもの」だけ。
 * 新着が無ければ上の early return で抜けているので、静かな時間帯は1回も呼ばない。
 * 鍵が未設定なら judge() が null を返し、表示は従来どおりになる。
 */
const needJudge = targets.filter(t => !covered.has(normalize(t.item.url)));
const judged = new Map();
if (jev.enabled && needJudge.length) {
    // 最大12件。4並行で回しても数秒で返る
    await jev.inParallel(needJudge, async t => {
        judged.set(t.item.url, await judge(t.item, t.source));
    });
    console.log(`  … ${jev.usageLine()}`);
}

let posted = 0;
try {
    // 1件につき1メッセージ。まとめて出すと、あとで1件だけ ✅ に直すときに
    // 同じメッセージの他の埋め込みまで作り直すことになるため。
    for (const t of targets) {
        const isCovered = covered.has(normalize(t.item.url));
        const embed = embedOf(t.item, t.source, isCovered, judged.get(t.item.url) || null);
        const msg = await postToDiscord([embed]);
        posted++;

        // まだ書かれていないものだけ、あとで ✅ に直せるよう覚えておく
        // （🟡 も「確定していない」側なので追跡対象に含める）
        if (!isCovered && msg?.id) {
            pending[msg.id] = { url: t.item.url, at: new Date().toISOString(), embed };
        }

        // 投稿できたものだけを既読にする。ここで初めて state を更新する
        const list = Array.isArray(state[t.source.id]) ? state[t.source.id] : [];
        state[t.source.id] = [t.item.url, ...list].slice(0, KEEP_PER_SOURCE);

        await new Promise(r => setTimeout(r, 700)); // 連投を避ける
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
    const j = judged.get(t.item.url);
    const tag = j?.match && j.matchP >= SAME_ANNOUNCEMENT_MIN ? ' 🟡' : '';
    console.log(`   ${t.source.label}: ${t.item.title || t.item.url}${tag}`);
}
console.log(`  ${jev.usageLine()}`);

