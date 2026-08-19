/**
 * push-worker の VAPID 署名まわりの検証。
 *
 *   npm test
 *
 * Worker は Cloudflare 上でしか動かせないが、署名の組み立ては WebCrypto の
 * 標準APIだけでできているので、Node の crypto.subtle で同じ手順を再現して
 * 「作った JWT が公開鍵で検証できるか」を確かめる。
 * ここが間違っているとプッシュサービスに 401 で弾かれ、通知が一切届かない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const b64uEncode = bytes => Buffer.from(bytes).toString('base64url');
const b64uDecode = str => new Uint8Array(Buffer.from(str, 'base64url'));

/** VAPID の鍵ペアを作り、worker.js と同じ形（base64url）で返す */
async function generateVapidKeys() {
    const pair = await subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = await subtle.exportKey('raw', pair.publicKey);       // 非圧縮 65 バイト
    const jwk = await subtle.exportKey('jwk', pair.privateKey);
    return { publicKey: b64uEncode(pub), privateKey: jwk.d, verifyKey: pair.publicKey };
}

/** worker.js の importSigningKey と同じ手順 */
async function importSigningKey(publicKeyB64u, privateKeyB64u) {
    const pub = b64uDecode(publicKeyB64u);
    assert.equal(pub.length, 65, '公開鍵は非圧縮の65バイトであるべき');
    assert.equal(pub[0], 0x04, '公開鍵は 0x04 で始まるべき');
    return subtle.importKey(
        'jwk',
        {
            kty: 'EC',
            crv: 'P-256',
            x: b64uEncode(pub.slice(1, 33)),
            y: b64uEncode(pub.slice(33, 65)),
            d: privateKeyB64u,
            ext: false,
            key_ops: ['sign'],
        },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    );
}

/** worker.js の vapidHeader と同じ手順 */
async function vapidHeader(audience, subject, publicKeyB64u, key) {
    const enc = new TextEncoder();
    const seg = obj => b64uEncode(enc.encode(JSON.stringify(obj)));
    const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.' + seg({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
    });
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
    return {
        header: `vapid t=${unsigned}.${b64uEncode(sig)}, k=${publicKeyB64u}`,
        unsigned,
        sig,
    };
}

test('生成した鍵から作った JWT が、その公開鍵で検証できる', async () => {
    const keys = await generateVapidKeys();
    const signing = await importSigningKey(keys.publicKey, keys.privateKey);
    const { unsigned, sig } = await vapidHeader(
        'https://fcm.googleapis.com', 'mailto:test@example.com', keys.publicKey, signing);

    const ok = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.verifyKey,
        sig,
        new TextEncoder().encode(unsigned),
    );
    assert.ok(ok, 'JWT の署名が公開鍵で検証できませんでした');
    assert.equal(sig.byteLength, 64, 'ES256 の署名は r||s の 64 バイトであるべき');
});

test('Authorization ヘッダーが RFC 8292 の形になっている', async () => {
    const keys = await generateVapidKeys();
    const signing = await importSigningKey(keys.publicKey, keys.privateKey);
    const { header } = await vapidHeader(
        'https://updates.push.services.mozilla.com', 'mailto:test@example.com',
        keys.publicKey, signing);

    assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('JWT のペイロードに aud / exp / sub が入っている', async () => {
    const keys = await generateVapidKeys();
    const signing = await importSigningKey(keys.publicKey, keys.privateKey);
    const aud = 'https://wns2-by3p.notify.windows.com';
    const { unsigned } = await vapidHeader(aud, 'mailto:me@example.com', keys.publicKey, signing);

    const payload = JSON.parse(Buffer.from(unsigned.split('.')[1], 'base64url').toString());
    assert.equal(payload.aud, aud);
    assert.equal(payload.sub, 'mailto:me@example.com');
    assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'exp は未来であるべき');
    // 仕様上 exp は発行から24時間以内でなければならない
    assert.ok(payload.exp < Math.floor(Date.now() / 1000) + 24 * 3600, 'exp は24時間以内であるべき');
});
