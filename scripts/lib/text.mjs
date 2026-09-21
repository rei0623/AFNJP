/**
 * AFNJP ─ 文字列を切り詰めるときの共通処理
 *
 * X の下書きのように、決まった長さに収めるために文を途中で切る場面で使う。
 * 依存を持たない純粋な関数だけを置く（npm test で検証している）。
 */

/**
 * 戻しすぎの下限。元の長さのこの割合より手前にしか切れ目が無ければ、戻さない。
 *
 * 「途中で切れた文」より短いほうがましだが、「ほとんど何も残らない」よりは
 * 途中で切れているほうがまし、という線引き。
 */
export const MIN_KEEP = 0.75;

/**
 * 切り詰めた文字列を、意味の切れ目まで戻す。
 *
 * 長さだけで切ると「平均遅…」「ソフトウェア…」のように語の途中で終わり、
 * 何を言っているか分からなくなる。
 *
 * 踏んだ罠が2つある。
 *
 *   1. 句点を読点より優先すると、読点まで読める文でも手前の句点まで戻ってしまい、
 *      280字の枠を大きく余らせる（実測で 279字 の下書きが 199字 になった）。
 *      → 句読点の種類は問わず「いちばん後ろにあるもの」を採る。
 *         末尾に「…」を付けるので、読点で終わっても読みづらくはない。
 *
 *   2. 空白を切れ目に入れると「GPT Live」の途中で切れて「…GPT…」ができる。
 *      日本語の文では空白は語の区切りにならない。
 *      → 空白は切れ目に含めない。欧文の用語は語ごとまとめて落とす。
 */
export function trimToBoundary(s) {
    const stripped = String(s).replace(/[、。，．\s]+$/, '');
    if (!stripped) return '';
    const floor = stripped.length * MIN_KEEP;

    // 句読点のうち、いちばん後ろにあるもの
    let at = -1;
    for (const m of stripped.matchAll(/[。．！？、，]/g)) at = m.index;
    if (at + 1 >= floor) return stripped.slice(0, at + 1).replace(/[、，]$/, '');

    // 句読点が近くに無いので、語の途中で終わらない位置まで戻す。
    // 「GPT Live」のように空白を挟む欧文の用語はまとめて落とす
    const m = stripped.match(/(?:[A-Za-z0-9.+-]+(?:\s+[A-Za-z0-9.+-]+)*|[ァ-ヶー]+)$/);
    if (m && stripped.length - m[0].length >= floor) {
        return stripped.slice(0, stripped.length - m[0].length).replace(/\s+$/, '');
    }

    return stripped;
}
