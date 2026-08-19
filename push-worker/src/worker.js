/**
 * AFNJP ─ プッシュ通知の配信サーバー（Cloudflare Worker）
 *
 * GitHub Pages は静的配信なので、購読者リストを置く場所と、
 * プッシュサービスへ送る主体がどこかに必要になる。それがこの Worker。
 *
 * 経路:
 *   POST /subscribe    … ブラウザから購読を受け取り KV に保存する
 *   POST /unsubscribe  … 購読を削除する
 *   POST /notify       … 新着があったとき GitHub Actions から叩く。50件ずつ送る
 *   GET  /count        … 購読者数（運用の目安。個人情報は返さない）
 *
 * 通知はペイロードを持たない。
 *   本文を載せると購読者ごとに ECDH + AES-GCM の暗号化が要り、
 *   無料枠の CPU 10ms/リクエストに収まらない。「新着があった」という
 *   合図だけ送り、中身はブラウザ側の sw.js が posts.json を読んで組み立てる。
 *
 * 必要なシークレット（wrangler secret put で登録する）:
 *   VAPID_PUBLIC_KEY  … base64url の公開鍵（サイトにも同じものを置く）
 *   VAPID_PRIVATE_KEY … base64url の秘密鍵。絶対に公開しないこと
 *   VAPID_SUBJECT     … mailto:you@example.com もしくはサイトURL
 *   SEND_TOKEN        … /notify を叩けるのを自分だけにするための合言葉
 *
 * 必要なバインディング:
 *   SUBS … Workers KV の名前空間
 */

/** 購読を受け付けるサイト。ここに無いオリジンからは登録させない */
const ALLOWED_ORIGINS = new Set([
    'https://rei0623.github.io',
    'http://localhost:4321', // ローカル確認用
]);

/** 1回の /notify で送る件数。Workers 無料枠のサブリクエスト上限が 50/リクエストのため */
const BATCH = 45;

/* ═══════════ base64url ═══════════ */

const b64uEncode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64uDecode(str) {
    const pad = '='.repeat((4 - str.length % 4) % 4);
    const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/* ═══════════ VAPID ═══════════ */

/**
 * VAPID の署名鍵を読み込む。
 * 公開鍵は非圧縮点（0x04 || x(32) || y(32)）なので、そこから JWK を組む。
 */
async function importSigningKey(publicKeyB64u, privateKeyB64u) {
    const pub = b64uDecode(publicKeyB64u);
    if (pub.length !== 65 || pub[0] !== 0x04) {
        throw new Error('VAPID_PUBLIC_KEY の形式が不正です（非圧縮の65バイトである必要があります）');
    }
    return crypto.subtle.importKey(
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

/**
 * プッシュサービスへ渡す Authorization ヘッダーを作る。
 * aud はプッシュサービスのオリジンごとに変わるので、オリジン単位で使い回す。
 */
async function vapidHeader(audience, env, key) {
    const enc = new TextEncoder();
    const seg = obj => b64uEncode(enc.encode(JSON.stringify(obj)));

    const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.' + seg({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT,
    });

    // WebCrypto の ECDSA は r||s の生の64バイトを返す。これは JWS ES256 が求める形と同じ
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));

    return `vapid t=${unsigned}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/* ═══════════ KV ═══════════ */

/** endpoint をそのまま鍵にすると 512 バイト制限を超えることがあるのでハッシュ化する */
async function keyOf(endpoint) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return 'sub:' + b64uEncode(digest);
}

/* ═══════════ 応答の道具 ═══════════ */

function cors(origin) {
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : null;
    return allowed ? {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    } : { Vary: 'Origin' };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});

/* ═══════════ 本体 ═══════════ */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const head = cors(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: head });
        }

        /* ── 購読の登録 ── */
        if (url.pathname === '/subscribe' && request.method === 'POST') {
            if (!ALLOWED_ORIGINS.has(origin)) return json({ error: 'origin' }, 403, head);

            let sub;
            try {
                sub = await request.json();
            } catch {
                return json({ error: 'json' }, 400, head);
            }
            if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
                return json({ error: 'endpoint' }, 400, head);
            }

            // 保存するのは購読に必要な最小限だけ。IPやUAは保存しない
            await env.SUBS.put(await keyOf(sub.endpoint), JSON.stringify({
                endpoint: sub.endpoint,
                created_at: new Date().toISOString(),
            }));
            return json({ ok: true }, 201, head);
        }

        /* ── 購読の解除 ── */
        if (url.pathname === '/unsubscribe' && request.method === 'POST') {
            if (!ALLOWED_ORIGINS.has(origin)) return json({ error: 'origin' }, 403, head);

            let body;
            try {
                body = await request.json();
            } catch {
                return json({ error: 'json' }, 400, head);
            }
            if (typeof body?.endpoint !== 'string') return json({ error: 'endpoint' }, 400, head);

            await env.SUBS.delete(await keyOf(body.endpoint));
            return json({ ok: true }, 200, head);
        }

        /* ── 購読者数 ── */
        if (url.pathname === '/count' && request.method === 'GET') {
            const list = await env.SUBS.list({ limit: 1000 });
            return json({ count: list.keys.length, complete: list.list_complete }, 200, head);
        }

        /* ── 通知の送信（GitHub Actions から） ── */
        if (url.pathname === '/notify' && request.method === 'POST') {
            const auth = request.headers.get('Authorization') || '';
            if (!env.SEND_TOKEN || auth !== `Bearer ${env.SEND_TOKEN}`) {
                return json({ error: 'unauthorized' }, 401);
            }

            const cursor = url.searchParams.get('cursor') || undefined;
            const list = await env.SUBS.list({ limit: BATCH, cursor });

            const signingKey = await importSigningKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
            const headerCache = new Map(); // プッシュサービスのオリジン -> Authorization

            let sent = 0, gone = 0, failed = 0;

            await Promise.all(list.keys.map(async ({ name }) => {
                const raw = await env.SUBS.get(name);
                if (!raw) return;

                let endpoint;
                try {
                    endpoint = JSON.parse(raw).endpoint;
                } catch {
                    return;
                }
                if (!endpoint) return;

                const audience = new URL(endpoint).origin;
                if (!headerCache.has(audience)) {
                    headerCache.set(audience, await vapidHeader(audience, env, signingKey));
                }

                try {
                    // ペイロードなし。Content-Length: 0 で送る
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            Authorization: headerCache.get(audience),
                            TTL: '86400',
                            Urgency: 'normal',
                            'Content-Length': '0',
                        },
                    });

                    if (res.status === 404 || res.status === 410) {
                        // 端末側で購読が失効している。放置すると毎回無駄打ちになるので消す
                        await env.SUBS.delete(name);
                        gone++;
                    } else if (res.ok) {
                        sent++;
                    } else {
                        failed++;
                    }
                } catch {
                    failed++;
                }
            }));

            return json({
                sent,
                gone,
                failed,
                cursor: list.list_complete ? null : list.cursor,
                done: list.list_complete,
            }, 200);
        }

        return json({ error: 'not found' }, 404, head);
    },
};
