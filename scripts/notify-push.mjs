#!/usr/bin/env node
/**
 * AFNJP ─ 新着記事があったらプッシュ通知を送る
 *
 * posts-archive.json の最新記事が前回送ったものと変わっていたら、
 * Cloudflare Worker の /notify を叩いて購読者へ通知を出す。
 *
 * 通知はペイロードを持たない（「新着があった」という合図だけ）。
 * 中身はブラウザ側の sw.js が posts.json を読んで組み立てるので、
 * ここで記事の内容を送る必要はない。
 *
 * 送信先とトークン:
 *   push-config.json の endpoint … 公開情報なのでリポジトリに置いてある
 *   PUSH_SEND_TOKEN               … Worker と共有する合言葉。GitHub Secrets から渡す
 *
 * どちらかが欠けているときは何もせず正常終了する（未導入でもワークフローを壊さない）。
 *
 * 使い方:
 *   PUSH_SEND_TOKEN=xxxxx node scripts/notify-push.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ARCHIVE = resolve(ROOT, 'posts-archive.json');
const CONFIG = resolve(ROOT, 'push-config.json');
const STATE = resolve(ROOT, '.push-sent.json');

const TOKEN = process.env.PUSH_SEND_TOKEN;

/** 1回の実行で回すページ数の上限。想定外の暴走を防ぐ歯止め */
const MAX_PAGES = 40;

const config = await readFile(CONFIG, 'utf8').then(JSON.parse).catch(() => null);

if (!config?.enabled || !config.endpoint) {
    console.log('… プッシュ通知は未設定のため、送信をスキップします。');
    process.exit(0);
}
if (!TOKEN) {
    console.log('… PUSH_SEND_TOKEN が未設定のため、送信をスキップします。');
    process.exit(0);
}

const archive = await readFile(ARCHIVE, 'utf8').then(JSON.parse).catch(() => null);
const newest = archive?.posts?.[0];

if (!newest?.id) {
    console.log('… 記事が読めませんでした。送信をスキップします。');
    process.exit(0);
}

const prev = await readFile(STATE, 'utf8').then(JSON.parse).catch(() => null);

// 初回は「今の最新は通知済み」として記録するだけにする。
// これをしないと、導入した瞬間に既存記事の通知が飛んでしまう。
// last_id が空のファイルが置いてある状態も「初回」として扱う。
if (!prev?.last_id) {
    await writeFile(STATE, JSON.stringify({
        note: '最後に通知した記事ID。初回は既存の最新を通知済みとして記録している。',
        initialized_at: new Date().toISOString(),
        last_id: newest.id,
    }, null, 2) + '\n', 'utf8');
    console.log('✓ 初回セットアップ: 現在の最新記事を通知済みとして記録しました。');
    process.exit(0);
}

if (prev.last_id === newest.id) {
    console.log('✓ 新しい記事はありません。通知は送りません。');
    process.exit(0);
}

const base = config.endpoint.replace(/\/+$/, '');
let cursor = null;
let page = 0;
const total = { sent: 0, gone: 0, failed: 0 };

try {
    do {
        const url = `${base}/notify` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText} — ${await res.text()}`);
        }
        const r = await res.json();
        total.sent += r.sent || 0;
        total.gone += r.gone || 0;
        total.failed += r.failed || 0;
        cursor = r.done ? null : r.cursor;
        page++;
    } while (cursor && page < MAX_PAGES);
} catch (e) {
    // 送信に失敗したときは記録を進めない → 次回の実行で再試行される
    console.error(`✗ 通知の送信に失敗しました: ${e.message}`);
    process.exit(1);
}

await writeFile(STATE, JSON.stringify({
    note: '最後に通知した記事ID。初回は既存の最新を通知済みとして記録している。',
    initialized_at: prev.initialized_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_id: newest.id,
}, null, 2) + '\n', 'utf8');

console.log(`✓ プッシュ通知: ${total.sent} 件に送信`
    + (total.gone ? ` / 失効 ${total.gone} 件を削除` : '')
    + (total.failed ? ` / 失敗 ${total.failed} 件` : ''));
