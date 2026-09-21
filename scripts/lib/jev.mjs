/**
 * AFNJP ─ Jev（TypeSafe AI System One）への薄いラッパ
 *
 * Jev は文章を生成せず、型の付いた判断と確率だけを返すモデル。
 * 「このニュースは重要か」「この2つは同じ発表か」のような、
 * コードでは書けないが答えが一意に決まる判断だけを任せる。
 * 何を載せる・何を消すといった方針は、必ず呼び出し側のコードが持つこと。
 *
 * このリポジトリの作法に合わせた約束:
 *
 *   1. TYPESAFE_API_KEY が無ければ何もしない。
 *      ask() が null を返すので、呼び出し側は「判断が付かなかった」として
 *      従来どおりの動作を続ける。鍵を入れるまで挙動は1ミリも変わらない。
 *      （post-to-x.mjs / notify-push.mjs と同じ設計）
 *
 *   2. 1つの state に対する独立した問いは、必ず1回の呼び出しにまとめる。
 *      呼び出しを分けると同じ state を何度も課金することになる。
 *      出力トークンは無料なので、問いを増やしても増えるのは state のぶんだけ。
 *
 *   3. 1回の実行で投げるリクエスト数に上限を置く（MAX_CALLS_PER_RUN）。
 *      web-watch は5分ごとに動くため、暴発したときの歯止めが要る。
 *
 * 料金（2026-09 時点 https://docs.typesafe.ai/models）:
 *   入力 $0.042 / 1M トークン、出力は無料。無料枠は無い。
 *   AFNJP の実測では1件あたり約 1,400 トークン ＝ $0.00006。
 *   1日100件拾っても月 $0.18 程度に収まる。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

/** 1回のプロセス実行で投げるリクエストの上限。暴発したときの歯止め */
const MAX_CALLS_PER_RUN = Number(process.env.JEV_MAX_CALLS || 40);

/** 1リクエストのタイムアウト。判断が返らなくても本処理は止めない */
const TIMEOUT_MS = 20000;

const KEY = process.env.TYPESAFE_API_KEY;

/** 鍵が無ければ Jev は一切使わない。呼び出し側はこれを見て分岐してよい */
export const enabled = Boolean(KEY);

let calls = 0;
let inputTokens = 0;
let failures = 0;

/* ═══════════ 問いの組み立て ═══════════ */

/**
 * ひとつ選ぶ。選択肢は { 値: 説明 } で渡す。
 * 「どれにも当てはまらない」が起こりうるなら、その逃げ道を必ず入れること。
 * 入れないとモデルは無理にどれかを選ぶ。
 */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

/**
 * 順序のある段階で測る。criteria は下から順に並べた配列。
 * 各段階は「どういう状況か」が単独で読めるように書く（「高い」「低い」では判断できない）。
 */
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

/**
 * 条件が成り立つ確率を 0〜1 で返す。
 * 0.5 付近は「中くらいの強さ」ではなく「yes か no か分からない」を意味する。
 * 同時に複数立ちうるラベルは、1つの choice にせず noul を並べる。
 */
export const noul = (instructions, criteria) =>
    criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };

/* ═══════════ 呼び出し ═══════════ */

/**
 * state に対して questions をまとめて問う。
 *
 * 判断が取れなければ null を返す（例外は投げない）。
 * このリポジトリでの Jev はあくまで表示を良くするための補助なので、
 * Jev が落ちても新着の検知と投稿は止めない、という方針。
 *
 * @returns {Promise<Record<string, any> | null>} answers、または null
 */
export async function ask(state, questions) {
    if (!enabled) return null;
    if (calls >= MAX_CALLS_PER_RUN) return null;
    calls++;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: MODEL, state, questions }),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            failures++;
            console.warn(`  … Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return null;
        }
        const body = await res.json();
        inputTokens += body?.usage?.input_tokens || 0;
        return body?.answers ?? null;
    } catch (e) {
        failures++;
        console.warn(`  … Jev を呼べませんでした: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * items を並行数を絞って処理する。
 * 件ごとに state が違うので1件1リクエストになる。まとめられるのは
 * 「同じ state に対する複数の問い」だけで、それは questions 側でやること。
 */
export async function inParallel(items, fn, concurrency = 4) {
    let next = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/* ═══════════ 使用量 ═══════════ */

/** 実行の最後に1行出すためのもの。課金が想定より増えていないか毎回見えるように */
export function usageLine() {
    if (!enabled) return 'Jev: 未設定（TYPESAFE_API_KEY が無いので判断は行っていません）';
    if (!calls) return 'Jev: 呼び出しなし';
    const usd = (inputTokens / 1_000_000) * 0.042;
    return `Jev: ${calls} 回 / 入力 ${inputTokens.toLocaleString()} トークン / 約 $${usd.toFixed(6)}`
        + (failures ? `（失敗 ${failures} 回）` : '')
        + (calls >= MAX_CALLS_PER_RUN ? ` ※上限 ${MAX_CALLS_PER_RUN} 回に達しました` : '');
}

export const stats = () => ({ calls, inputTokens, failures, limit: MAX_CALLS_PER_RUN });
