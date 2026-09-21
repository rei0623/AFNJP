import test from 'node:test';
import assert from 'node:assert/strict';

import { trimToBoundary } from './text.mjs';

/*
 * ここの期待値は、実際の記事の要約で踏んだ壊れ方から作っている。
 * 「読点まで戻す」「空白では切らない」の2つが崩れると、
 * X の下書きが語の途中で終わる状態に戻る。
 */

test('いちばん後ろの句読点まで戻す（句点を優先しない）', () => {
    // 句点を優先すると「…公開しました」まで戻ってしまい、枠を大きく余らせる
    const s = 'OpenClawはv2026.9.5を公開しました。今回の更新では、稼働中のGatewayを維持したまま更新候補を検証するAtomic Updates、再起動不要のプラグイン更新';
    assert.equal(
        trimToBoundary(s),
        'OpenClawはv2026.9.5を公開しました。今回の更新では、稼働中のGatewayを維持したまま更新候補を検証するAtomic Updates',
    );
});

test('空白では切らない（欧文の用語を割らない）', () => {
    // 「…更新、GPT」で止めてしまうと、何の話か分からなくなる
    const s = 'OpenClawはv2026.9.5を公開しました。今回の更新では、稼働中のGatewayを維持したまま更新候補を検証するAtomic Updates、再起動不要のプラグイン更新、GPT';
    const got = trimToBoundary(s);
    assert.ok(!got.endsWith('GPT'), `欧文の用語が割れている: ${got}`);
    assert.ok(got.endsWith('プラグイン更新'), got);
});

test('末尾の読点は残さない', () => {
    assert.equal(trimToBoundary('あいうえおかきくけこさしすせそ、'), 'あいうえおかきくけこさしすせそ');
});

test('句読点が手前すぎるときは戻さない', () => {
    // 先頭付近にしか切れ目が無い。戻すとほとんど何も残らないので、そのまま出す
    const s = 'あ、いうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ';
    assert.equal(trimToBoundary(s), s);
});

test('句読点が無ければ欧文の用語ごと落とす', () => {
    const pre = 'モデルの性能を大きく引き上げる新しい仕組みとして今回あらたに導入されることになったのが';
    assert.equal(trimToBoundary(pre + 'Atomic Updates'), pre);
});

test('落とすと短くなりすぎる欧文は残す', () => {
    // 欧文が大部分を占めるので、落とすと MIN_KEEP を割る。
    // 「途中で切れている」より「ほとんど何も残らない」ほうが困るので、そのまま出す
    const s = '今回あらたに導入されたのがAtomic Updates';
    assert.equal(trimToBoundary(s), s);
});

test('カタカナ語の途中で終わらせない', () => {
    const s = 'あたらしい仕組みを導入して性能を引き上げたアーキテクチャ';
    assert.equal(trimToBoundary(s), 'あたらしい仕組みを導入して性能を引き上げた');
});

test('空文字・空白のみでも落ちない', () => {
    assert.equal(trimToBoundary(''), '');
    assert.equal(trimToBoundary('   '), '');
    assert.equal(trimToBoundary('、。'), '');
});
