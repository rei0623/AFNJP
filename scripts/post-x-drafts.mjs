#!/usr/bin/env node
/**
 * AFNJP ─ X（旧Twitter）投稿用の下書き生成
 *
 * posts.json に新しい記事が現れたら、X にそのまま貼れる投稿文を組み立てて
 * Discord の #x-下書き チャンネルへ送る。X API は一切使わない（無料）。
 *
 * 設計:
 *   - X と同じ重み付けで文字数を数える（全角=2 / 半角=1 / URL=一律23）
 *   - 280 に収まる位置で要約を自動カットする
 *   - 投稿済みの記事IDを .x-drafted.json に記録し、同じ記事を二度流さない
 *   - 記録ファイルが無い初回は「既存の記事はすべて投稿済み」として登録するだけで、
 *     まとめて大量に流さない（次回以降の新着から動きだす）
 *   - Discord への送信に失敗しても、記録は更新しない（次回に再試行される）
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN   … Bot トークン（#x-下書き への「メッセージを送信」権限が必要）
 *   X_DRAFT_CHANNEL_ID  … 送信先チャンネルID（省略時は #x-下書き のID）
 *
 * 使い方:
 *   DISCORD_BOT_TOKEN=xxxxx node scripts/post-x-drafts.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const POSTS_JSON = resolve(ROOT, 'posts.json');
const STATE = resolve(ROOT, '.x-drafted.json');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.X_DRAFT_CHANNEL_ID || '1534223121232560369';

/** X の投稿上限（重み付き） */
const X_LIMIT = 280;
/** X では URL は長さに関わらず一律この重みで数えられる */
const URL_WEIGHT = 23;
/** 1回の実行で流す下書きの上限。取りこぼし時に大量投下されるのを防ぐ */
const MAX_PER_RUN = 5;

if (!TOKEN) {
    console.error('✗ DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}

/**
 * X の重み付き文字数。
 * CJK・かな・全角記号・絵文字は 2、それ以外は 1 として数える。
 * （X の counting は Unicode の範囲で 1 と 2 を切り替える方式）
 */
function xWeight(str) {
    let n = 0;
    for (const ch of str) {
        const c = ch.codePointAt(0);
        if (
            (c >= 0x1100 && c <= 0x11ff) ||
            (c >= 0x2e80 && c <= 0xa4cf) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe30 && c <= 0xfe4f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) ||
            c > 0xffff // 絵文字など
        ) {
            n += 2;
        } else {
            n += 1;
        }
    }
    return n;
}

/** 本文＋URL の合計重み。URL は一律 URL_WEIGHT として数える */
function totalWeight(body, hasUrl) {
    return xWeight(body) + (hasUrl ? URL_WEIGHT : 0);
}

/**
 * 投稿文を組み立てる。
 * タイトルは必ず入れ、余った分だけ要約を入れる。
 */
function buildDraft(post) {
    const head = `🚨 ${post.title}\n\n`;
    const tail = '\n\n▼記事はこちら\n';
    const fixed = totalWeight(head + tail, true);

    // タイトルだけで溢れる場合は要約なしで出す（それでも超えるなら呼び出し側で弾く）
    let room = X_LIMIT - fixed;
    let excerpt = '';

    if (room > 0 && post.excerpt) {
        const src = post.excerpt.replace(/…$/, '');
        for (const ch of src) {
            if (xWeight(excerpt + ch) + 2 > room) break; // 末尾の「…」の2を残す
            excerpt += ch;
        }
        if (excerpt && excerpt.length < src.length) {
            excerpt = excerpt.replace(/[、。，．\s]+$/, '') + '…';
        }
    }

    const body = head + excerpt + tail;
    return { body, url: post.url, weight: totalWeight(body, true) };
}

async function discord(path, init = {}) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'AFNJP-x-draft/1.0',
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

/* ═══════════ 本処理 ═══════════ */

const data = await readFile(POSTS_JSON, 'utf8').then(JSON.parse).catch(() => null);
if (!data || !Array.isArray(data.posts) || !data.posts.length) {
    console.error('✗ posts.json を読めませんでした。');
    process.exit(1);
}

const prev = await readFile(STATE, 'utf8').then(JSON.parse).catch(() => null);

// 初回は既存記事をすべて「投稿済み」として登録するだけにする。
// これをしないと、導入した瞬間に手元の記事すべての下書きが流れてしまう。
if (!prev) {
    await writeFile(STATE, JSON.stringify({
        note: 'X下書きを流した記事のID。初回は既存記事を投稿済みとして登録している。',
        initialized_at: new Date().toISOString(),
        drafted: data.posts.map(p => p.id),
    }, null, 2) + '\n', 'utf8');
    console.log(`✓ 初回セットアップ: 既存 ${data.posts.length} 件を投稿済みとして登録しました`);
    console.log('  次回の同期から、新しい記事の下書きが #x-下書き に流れます。');
    process.exit(0);
}

const done = new Set(prev.drafted || []);

// posts.json は新しい順なので、古い記事から順に流すため反転する
const fresh = data.posts.filter(p => !done.has(p.id)).reverse();

if (!fresh.length) {
    console.log('✓ 新しい記事はありません。');
    process.exit(0);
}

const targets = fresh.slice(0, MAX_PER_RUN);
if (fresh.length > MAX_PER_RUN) {
    console.warn(`  … 新着 ${fresh.length} 件のうち ${MAX_PER_RUN} 件を処理します（残りは次回）`);
}

let sent = 0;
for (const post of targets) {
    const draft = buildDraft(post);

    if (draft.weight > X_LIMIT) {
        console.warn(`  … 「${post.title}」はタイトルだけで上限を超えるためスキップします（${draft.weight}）`);
        done.add(post.id); // 何度も警告しないよう記録はする
        continue;
    }

    // 2通に分けて送る。
    // スマホの Discord にはコードブロックのコピーボタンが無く、長押しの
    // 「テキストをコピー」はメッセージ全体（見出しやバッククォート込み）を拾う。
    // そのため下書き本体は装飾を一切付けない単独メッセージにして、
    // 長押ししたものがそのまま X に貼れるようにする。
    const header =
        `**X投稿用**  \`${draft.weight}/${X_LIMIT}\`  ・ ${post.channel}\n` +
        '-# 下のメッセージを長押し →「テキストをコピー」でそのまま貼れます';
    const body = draft.body + draft.url;

    try {
        await discord(`/channels/${CHANNEL_ID}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content: header, flags: 4 }), // flags:4 = 埋め込みを抑制
        });
        await new Promise(r => setTimeout(r, 400));
        await discord(`/channels/${CHANNEL_ID}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content: body, flags: 4 }),
        });
        done.add(post.id);
        sent++;
        console.log(`  ✓ ${post.title}（${draft.weight}/${X_LIMIT}）`);
        await new Promise(r => setTimeout(r, 700)); // 連投を避ける
    } catch (e) {
        // 送信に失敗した記事は記録しない → 次回の実行で再試行される
        console.error(`  ✗ 送信に失敗: ${post.title}`);
        console.error(`     ${e.message}`);
        break;
    }
}

if (sent > 0) {
    await writeFile(STATE, JSON.stringify({
        note: 'X下書きを流した記事のID。初回は既存記事を投稿済みとして登録している。',
        initialized_at: prev.initialized_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        drafted: [...done],
    }, null, 2) + '\n', 'utf8');
}

console.log(`✓ X下書き: ${sent} 件を #x-下書き に送りました`);
