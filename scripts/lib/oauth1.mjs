/**
 * OAuth 1.0a（HMAC-SHA1）の署名。X への投稿で使う。
 *
 * X の投稿 API はユーザーコンテキストの OAuth 1.0a を要求する。
 * 外部ライブラリを足さずに済ませたいので、node:crypto だけで組んでいる。
 *
 * 正しさは scripts/lib/oauth1.test.mjs で、X 公式ドキュメントに載っている
 * 既知の署名例と突き合わせて確認している。
 */

import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 3986 のパーセントエンコード。
 * encodeURIComponent は ! * ' ( ) を残すが、OAuth の署名では
 * これらもエンコードしないと署名が一致しない。
 */
export const pct = s => encodeURIComponent(String(s)).replace(/[!*'()]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Authorization ヘッダーの値を組み立てる。
 *
 * @param {string} method   HTTP メソッド
 * @param {string} url      クエリを含まない URL
 * @param {object} creds    { key, secret, token, tokenSecret }
 * @param {object} extra    クエリ文字列やフォーム本文のパラメータ。
 *                          本文が JSON のときは署名に含めないので空にする。
 * @param {object} fixed    テスト用に nonce / timestamp を固定するためのもの
 */
export function authHeader(method, url, creds, extra = {}, fixed = {}) {
    const oauth = {
        oauth_consumer_key: creds.key,
        oauth_nonce: fixed.nonce || randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: fixed.timestamp || String(Math.floor(Date.now() / 1000)),
        oauth_token: creds.token,
        oauth_version: '1.0',
    };

    const params = { ...oauth, ...extra };
    const paramString = Object.keys(params).sort()
        .map(k => `${pct(k)}=${pct(params[k])}`)
        .join('&');

    const base = [method.toUpperCase(), pct(url), pct(paramString)].join('&');
    const signingKey = `${pct(creds.secret)}&${pct(creds.tokenSecret)}`;
    const signature = createHmac('sha1', signingKey).update(base).digest('base64');

    // ヘッダーに載せるのは oauth_* だけ。extra は URL や本文の側にある。
    const all = { ...oauth, oauth_signature: signature };
    return 'OAuth ' + Object.keys(all).sort()
        .map(k => `${pct(k)}="${pct(all[k])}"`)
        .join(', ');
}
