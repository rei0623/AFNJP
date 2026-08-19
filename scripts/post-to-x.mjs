#!/usr/bin/env node
/**
 * AFNJP ─ 承認された下書きだけを X へ投稿する
 *
 * scripts/post-x-drafts.mjs が Discord の #x-下書き に流した下書きのうち、
 * 「✅ のリアクションが付いたもの」だけを X に投稿する。
 *
 * なぜこの形か:
 *   AFNJP は「人が確かめてから出す」ことを原則にしている。完全自動投稿は
 *   その原則と衝突するため、Discord 上での ✅ を人の承認とみなす半自動にした。
 *   承認しなければ何も出ない。誤爆したときは ✅ を付けなければよい。
 *
 * 動き:
 *   1. #x-下書き の直近メッセージを読む
 *   2. Bot が出した「下書き本体」のうち ✅ が付いたものを拾う
 *   3. まだ投稿していないものを X に投稿する
 *   4. 投稿できたら Discord のそのメッセージに 🚀 を付け、.x-posted.json に記録する
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN … Bot トークン（履歴の読み取りとリアクション追加の権限が必要）
 *   X_API_KEY         … X アプリの API Key（Consumer Key）
 *   X_API_SECRET      … X アプリの API Key Secret
 *   X_ACCESS_TOKEN    … アカウントの Access Token（Read and write 権限）
 *   X_ACCESS_SECRET   … アカウントの Access Token Secret
 *   X_DRAFT_CHANNEL_ID … 省略時は #x-下書き のID
 *
 * X の鍵が1つでも無いときは、何もせず正常終了する（導入前でもワークフローを壊さない）。
 *
 * 使い方:
 *   DISCORD_BOT_TOKEN=xxx X_API_KEY=... node scripts/post-to-x.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { authHeader } from './lib/oauth1.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STATE = resolve(ROOT, '.x-posted.json');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.X_DRAFT_CHANNEL_ID || '1534223121232560369';

const X = {
    key: process.env.X_API_KEY,
    secret: process.env.X_API_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_SECRET,
};

/** 承認を示すリアクション */
const APPROVE = '✅';
/** 投稿済みを示すリアクション（人が見て分かるようにするため） */
const DONE = '🚀';

/** 1回の実行で投稿する上限。事故ったときに連投しないための歯止め */
const MAX_PER_RUN = 3;
/** 読み取る履歴の件数 */
const HISTORY_LIMIT = 50;

if (!TOKEN) {
    console.error('✗ DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}

if (!X.key || !X.secret || !X.token || !X.tokenSecret) {
    console.log('… X の認証情報が未設定のため、自動投稿はスキップします。');
    process.exit(0);
}

/* ═══════════ Discord ═══════════ */

async function discord(path, init = {}) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'AFNJP-x-post/1.0',
            ...(init.headers || {}),
        },
    });
    if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 2);
        console.warn(`  … レート制限。${retry}s 待機`);
        await new Promise(r => setTimeout(r, retry * 1000 + 250));
        return discord(path, init);
    }
    if (!res.ok) {
        throw new Error(`Discord API ${res.status} ${res.statusText} — ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
}

/* ═══════════ X ═══════════ */

/**
 * X に1件投稿する。成功したら投稿IDを返す。
 * 本文は JSON なので、OAuth の署名に含めるパラメータは無い（第4引数は空）。
 */
async function tweet(text) {
    const url = 'https://api.x.com/2/tweets';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: authHeader('POST', url, X),
            'Content-Type': 'application/json',
            'User-Agent': 'AFNJP-x-post/1.0',
        },
        body: JSON.stringify({ text }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`X API ${res.status} ${res.statusText} — ${body}`);
    try {
        return JSON.parse(body)?.data?.id ?? null;
    } catch {
        return null;
    }
}

/* ═══════════ 本処理 ═══════════ */

const prev = await readFile(STATE, 'utf8').then(JSON.parse).catch(() => null);
const posted = new Set(prev?.posted || []);

const messages = await discord(`/channels/${CHANNEL_ID}/messages?limit=${HISTORY_LIMIT}`);

/**
 * 承認済みの下書き本体を拾う。
 * post-x-drafts.mjs は「見出し」と「本体」の2通を送っており、
 * 見出しのほうは **X投稿用** で始まる。本体だけを対象にする。
 */
const approved = messages
    .filter(m => m.author?.bot)
    .filter(m => !m.content.startsWith('**X投稿用**'))
    .filter(m => m.content.trim())
    .filter(m => (m.reactions || []).some(r => r.emoji?.name === APPROVE))
    .filter(m => !posted.has(m.id))
    // 古いものから順に投稿する（Discord は新しい順に返す）
    .reverse();

if (!approved.length) {
    console.log('✓ 承認済み（✅）の未投稿の下書きはありません。');
    process.exit(0);
}

const targets = approved.slice(0, MAX_PER_RUN);
if (approved.length > MAX_PER_RUN) {
    console.warn(`  … 承認済み ${approved.length} 件のうち ${MAX_PER_RUN} 件を投稿します（残りは次回）`);
}

let sent = 0;
for (const m of targets) {
    try {
        const id = await tweet(m.content);
        posted.add(m.id);
        sent++;
        console.log(`  ✓ 投稿しました${id ? `（https://x.com/AI_FrontierNews/status/${id}）` : ''}`);

        // Discord 側にも「投稿済み」を残す。失敗しても投稿そのものは成功しているので止めない。
        await discord(
            `/channels/${CHANNEL_ID}/messages/${m.id}/reactions/${encodeURIComponent(DONE)}/@me`,
            { method: 'PUT' },
        ).catch(() => console.warn('  … 🚀 のリアクションを付けられませんでした'));

        await new Promise(r => setTimeout(r, 1500)); // 連投を避ける
    } catch (e) {
        // 投稿に失敗したものは記録しない → 次回の実行で再試行される
        console.error(`  ✗ 投稿に失敗しました: ${e.message}`);
        break;
    }
}

if (sent > 0) {
    await writeFile(STATE, JSON.stringify({
        note: 'X へ投稿済みの Discord メッセージID。同じ下書きを二度投稿しないための記録。',
        updated_at: new Date().toISOString(),
        posted: [...posted].slice(-500), // 際限なく増えないよう直近500件だけ持つ
    }, null, 2) + '\n', 'utf8');
}

console.log(`✓ X投稿: ${sent} 件`);
