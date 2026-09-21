#!/usr/bin/env node
/**
 * AFNJP ─ 記事に「発表の種類」のタグを付ける
 *
 * なぜ Jev に聞くのか:
 *   企業名（Open AI / Google / Anthropic …）は Discord のチャンネル構成から
 *   そのまま取れるので、モデルに聞く必要はない。category が既にそれ。
 *   一方で「新しいモデルが出たのか、既存機能の更新なのか、研究成果なのか、
 *   資金調達の話なのか」は本文を読まないと分からず、コードでは書けない。
 *   アーカイブを絞り込めるようにするために、ここだけを判断させる。
 *
 * 課金の抑え方:
 *   すでに kind が付いている記事は二度と推論しない。
 *   初回だけ全件（208件で約 $0.005）、以後は新着ぶんだけになる。
 *   記事は投稿後に書き換わらない運用なので、付け直す必要もない。
 *
 * 実行:
 *   node scripts/tag-posts.mjs            … kind の無い記事にタグを付ける
 *   node scripts/tag-posts.mjs --dry-run  … 何件対象になるかだけ見る（課金なし）
 *   node scripts/tag-posts.mjs --retag    … 全件を付け直す（分類を変えたとき）
 *
 * TYPESAFE_API_KEY が無ければ何もせず正常終了する。
 * posts-archive.json は sync-discord.mjs が毎時上書きするが、
 * 既存フィールドは引き継がれる作りなので kind は消えない。
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as jev from './lib/jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ARCHIVE = resolve(ROOT, 'posts-archive.json');

const DRY = process.argv.includes('--dry-run');
const RETAG = process.argv.includes('--retag');

/**
 * 発表の種類。
 *
 * 「どれにも当てはまらない」の逃げ道を必ず置く。置かないとモデルは
 * 無理にどれかを選び、その1件だけ的外れなタグが付く。
 *
 * 増やすときは --retag で付け直すこと。途中から選択肢を足すと、
 * 古い記事は新しい選択肢を一度も検討されていない状態になる。
 */
const KINDS = {
    model: '新しいモデル・新バージョンの公開や提供開始',
    feature: '既存の製品・サービスへの機能追加や改良、値下げ、提供範囲の拡大',
    research: '研究成果・論文・技術的な手法の公開。評価やベンチマークの結果',
    tool: '開発者向けのツール・API・SDK・エージェント基盤に関する発表',
    business: '資金調達、買収、提携、組織変更、経営や事業方針に関する動向',
    policy: '規制・法令・訴訟・安全性の方針・利用規約に関する話',
    adoption: '導入事例・ユースケース・特定企業での活用の紹介',
    other: '上記のどれにも当てはまらない',
};

/** 表示用の日本語名。archive.html の絞り込みに使う */
export const KIND_LABEL = {
    model: 'モデル公開',
    feature: '機能追加',
    research: '研究・評価',
    tool: '開発者向け',
    business: '企業動向',
    policy: '規制・方針',
    adoption: '導入事例',
    other: 'その他',
};

/**
 * 判断が割れたものは other にせず、そのまま記録して confidence を残す。
 * 絞り込みは「だいたい合っていれば役に立つ」性質の機能なので、
 * 迷ったぶんを捨てるより、確信度を添えて残すほうが使える。
 */
const MIN_CONFIDENCE = 0.35;

async function main() {
    const raw = await readFile(ARCHIVE, 'utf8');
    const data = JSON.parse(raw);
    const posts = data.posts || [];

    const targets = posts.filter(p => RETAG || !p.kind);
    if (!targets.length) {
        console.log(`✓ タグ付けの対象はありません（全 ${posts.length} 件に kind が付いています）`);
        return;
    }

    if (DRY) {
        console.log(`対象 ${targets.length} 件 / 全 ${posts.length} 件`);
        const est = (targets.length * 550 / 1_000_000) * 0.042;
        console.log(`推定: 入力 約 ${(targets.length * 550).toLocaleString()} トークン / 約 $${est.toFixed(4)}`);
        for (const p of targets.slice(0, 5)) console.log(`  … ${p.title}`);
        if (targets.length > 5) console.log(`  … 他 ${targets.length - 5} 件`);
        return;
    }

    if (!jev.enabled) {
        console.log('… TYPESAFE_API_KEY が未設定のため、タグ付けをスキップします。');
        return;
    }

    console.log(`${targets.length} 件にタグを付けます（全 ${posts.length} 件）`);

    let done = 0, low = 0;
    await jev.inParallel(targets, async p => {
        const answers = await jev.ask({
            article: {
                title: p.title,
                lead: p.lead || p.excerpt || null,
                headings: p.headings || [],
                publisher: p.source_label || null,
            },
        }, {
            kind: jev.choice(
                'この記事が伝えている発表は、どの種類にあたるか。'
                + '`article.title` と `article.lead`、`article.headings` の内容で判断する。'
                + '複数に当てはまるように見えるときは、記事の主題として最も中心にあるものを選ぶ',
                KINDS,
            ),
        });
        if (!answers?.kind) return;

        p.kind = answers.kind.choice;
        p.kind_confidence = Number(answers.kind.confidence.toFixed(2));
        if (answers.kind.confidence < MIN_CONFIDENCE) low++;
        done++;
    });

    if (!done) {
        console.log('… 1件もタグを付けられませんでした。posts-archive.json は変更していません。');
        console.log(jev.usageLine());
        return;
    }

    // 壊れた JSON を置かないよう、一時ファイルに書いてから差し替える
    const out = JSON.stringify({ ...data, posts }, null, 2) + '\n';
    JSON.parse(out); // 書く前に読めることを確かめる
    const tmp = `${ARCHIVE}.tmp`;
    await writeFile(tmp, out, 'utf8');
    await rename(tmp, ARCHIVE);

    const tally = {};
    for (const p of posts) if (p.kind) tally[p.kind] = (tally[p.kind] || 0) + 1;

    console.log(`✓ ${done} 件にタグを付けました`
        + (low ? `（うち ${low} 件は確信度が低め）` : ''));
    console.log('  ' + Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${KIND_LABEL[k] || k} ${n}`).join(' / '));
    console.log(jev.usageLine());
}

await main();
