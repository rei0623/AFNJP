/**
 * OAuth 1.0a 署名の検証。
 *
 *   node --test scripts/lib/
 *
 * X（旧Twitter）の開発者ドキュメント "Creating a signature" に載っている
 * 既知の入力と署名を使って、パーセントエンコード・パラメータの並べ替え・
 * 署名ベース文字列・HMAC-SHA1 が正しいことを確かめる。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { authHeader, pct } from './oauth1.mjs';

const CREDS = {
    key: 'xvz1evFS4wEEPTGEFPHBog',
    secret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
};

test('パーセントエンコードは ! * \' ( ) も対象にする', () => {
    assert.equal(pct("!*'()"), '%21%2A%27%28%29');
    assert.equal(pct('Ladies + Gentlemen'), 'Ladies%20%2B%20Gentlemen');
});

test('公式ドキュメントの例と署名が一致する', () => {
    // docs.x.com の "Creating a signature" に載っている値。
    // 期待する署名は Ls93hJiZbQ3akF3HF3x1Bz8/zU4=
    const header = authHeader(
        'POST',
        'https://api.x.com/1.1/statuses/update.json',
        CREDS,
        {
            status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
            include_entities: 'true',
        },
        {
            nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
            timestamp: '1318622958',
        },
    );

    assert.match(header, /oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"/);
});

test('ヘッダーには oauth_* だけが載り、本文のパラメータは載らない', () => {
    const header = authHeader('POST', 'https://api.x.com/2/tweets', CREDS, {}, {
        nonce: 'abc', timestamp: '1700000000',
    });
    assert.ok(header.startsWith('OAuth '));
    assert.ok(header.includes('oauth_consumer_key='));
    assert.ok(header.includes('oauth_signature='));
    assert.ok(!header.includes('status='));
});
