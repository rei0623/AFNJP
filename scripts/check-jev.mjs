#!/usr/bin/env node
/**
 * AFNJP ─ Jev の鍵が生きているかを確かめる
 *
 * なぜ要るか:
 *   Jev を使う処理は、判断が取れなくても本処理を止めない作りにしてある（lib/jev.mjs）。
 *   そのため鍵が無効になっても何も落ちず、2026-10-08 から4日間、種類のラベル・重要度・
 *   AI以外の除外・記事の種類付けが黙って止まっていた（TypeSafe 側で 401 が返っていた）。
 *
 *   このスクリプトは最小の問いを1回だけ投げ、通らなければ終了コード 1 で終わる。
 *   ワークフローが失敗すると GitHub がリポジトリの持ち主にメールで知らせる。
 *   Discord には投げない（公開チャンネルに運営の事情を出さないため）。
 *
 * 費用: 1回あたり数十トークン（$0.000004 程度）。jev-health.yml が1日1回呼ぶ。
 *
 * TYPESAFE_API_KEY が無ければ何もせず正常終了する（鍵を入れていない運用もありうるため）。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.TYPESAFE_API_KEY;

if (!KEY) {
    console.log('… TYPESAFE_API_KEY が未設定のため、確認をスキップします。');
    process.exit(0);
}

async function once() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'jev-latest',
                state: { text: 'OpenAI が新しいモデルを公開した' },
                questions: { ok: { type: 'noul', instructions: '`text` は AI に関する話である' } },
            }),
            signal: ctrl.signal,
        });
        return { status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 200) };
    } catch (e) {
        return { status: 0, body: e.name === 'AbortError' ? '20秒以内に応答がありません' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

// 一時的な不調でメールを出さないよう、認証エラー以外は1回だけやり直す
let r = await once();
if (r.status !== 401 && r.status !== 403 && (r.status === 0 || r.status >= 500)) {
    await new Promise(ok => setTimeout(ok, 5000));
    r = await once();
}

if (r.status >= 200 && r.status < 300) {
    console.log('✓ Jev の鍵は有効です。');
    process.exit(0);
}

console.error(`✗ Jev を呼べません（${r.status || '通信エラー'}）: ${r.body}`);
if (r.status === 401 || r.status === 403) {
    console.error('   鍵が無効です。TypeSafe のコンソール（https://console.typesafe.ai/keys）で鍵を作り直し、');
    console.error('   GitHub の Settings → Secrets → Actions の TYPESAFE_API_KEY を差し替えてください。');
} else if (r.status === 402) {
    console.error('   残高が足りない可能性があります。TypeSafe のコンソールで残高を確認してください。');
}
console.error('   直るまで、種類のラベル・重要度・AI以外の除外・記事の種類付けは止まったままです。');
process.exit(1);
