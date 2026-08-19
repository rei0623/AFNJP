/*
 * AFNJP ─ Service Worker
 *
 * 目的は2つ:
 *   1. ホーム画面に追加したときにアプリのように動くこと（オフラインでも読める）
 *   2. 新着記事のプッシュ通知を受け取ること
 *
 * 通知の設計:
 *   プッシュは「新着があった」という合図だけで、本文を持たない（ペイロードなし）。
 *   本文を載せると購読者ごとに暗号化が要り、Cloudflare Workers の無料枠
 *   （CPU 10ms/リクエスト）に収まらないため。中身はここで posts.json を
 *   読んで組み立てる。結果として、通知の文面はサーバーを触らずに変えられる。
 *
 * キャッシュ方針:
 *   HTML と JSON … ネットワーク優先（記事は毎時更新されるので鮮度が大事）
 *   CSS と画像   … キャッシュ優先（画像はファイル名が記事IDなので中身が変わらない）
 */

const VERSION = 'v1';
const SHELL = `afnjp-shell-${VERSION}`;
const RUNTIME = `afnjp-runtime-${VERSION}`;

/** 最初から入れておくもの。ここが失敗するとインストール自体が失敗するので最小限にする */
const PRECACHE = [
    './',
    './index.html',
    './archive.html',
    './assets/article.css',
    './assets/icons/icon-192.png',
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        // 1つでも失敗すると addAll 全体が落ちるため、個別に入れて失敗は無視する
        await Promise.all(PRECACHE.map(url =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => { })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(k => k.startsWith('afnjp-') && k !== SHELL && k !== RUNTIME)
            .map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

/* ═══════════ 取得 ═══════════ */

const isAsset = url => /\.(css|png|jpg|jpeg|webp|gif|svg|woff2?)$/i.test(url.pathname);

/** ネットワーク優先。取れたらキャッシュを更新し、落ちたらキャッシュで返す */
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        const hit = await cache.match(request);
        if (hit) return hit;
        throw new Error('offline');
    }
}

/** キャッシュ優先。無ければ取りに行き、取れたら保存する */
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // 別ドメイン（Discord API・フォント・プッシュ購読先など）には手を出さない
    if (url.origin !== self.location.origin) return;

    // ページ遷移: ネットワーク優先。オフラインならキャッシュ、それも無ければトップ
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                return await networkFirst(request, RUNTIME);
            } catch {
                return (await caches.match('./index.html'))
                    || new Response('オフラインです。', {
                        status: 503,
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    });
            }
        })());
        return;
    }

    if (isAsset(url)) {
        event.respondWith(cacheFirst(request, RUNTIME).catch(() => caches.match(request)));
        return;
    }

    // posts.json / channels.json / feed.xml など
    event.respondWith(networkFirst(request, RUNTIME).catch(() => caches.match(request)));
});

/* ═══════════ プッシュ通知 ═══════════ */

/** 通知に出す新着記事を posts.json から拾う */
async function latestPosts() {
    const res = await fetch('./posts.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.posts) ? data.posts : [];
}

/**
 * どこまで通知したかを Cache Storage に覚えておく。
 * IndexedDB を使うほどのものではないので、印だけを1つ置く。
 */
const MARK = './__afnjp_last_notified';

async function readMark() {
    const cache = await caches.open(RUNTIME);
    const hit = await cache.match(MARK);
    return hit ? (await hit.text()) : null;
}

async function writeMark(id) {
    const cache = await caches.open(RUNTIME);
    await cache.put(MARK, new Response(String(id)));
}

self.addEventListener('push', event => {
    event.waitUntil((async () => {
        let posts = [];
        try {
            posts = await latestPosts();
        } catch { /* 取得できなければ下の汎用文で出す */ }

        if (!posts.length) {
            await self.registration.showNotification('AI Frontier News JP', {
                body: '新しい記事が届いています。',
                icon: './assets/icons/icon-192.png',
                badge: './assets/icons/icon-192.png',
                tag: 'afnjp-news',
                data: { url: './index.html' },
            });
            return;
        }

        const newest = posts[0];
        const last = await readMark();

        // 前回通知した記事より新しいものが何本あるか数える
        const idx = last ? posts.findIndex(p => String(p.id) === last) : -1;
        const fresh = idx > 0 ? idx : (idx === 0 ? 0 : 1);
        if (fresh === 0) return; // 新着なし。通知を出さない

        const more = fresh > 1 ? `　ほか${fresh - 1}本` : '';

        await self.registration.showNotification(newest.title, {
            body: (newest.excerpt || 'AI Frontier News JP の新着記事です。') + more,
            icon: './assets/icons/icon-192.png',
            badge: './assets/icons/icon-192.png',
            image: newest.cover ? './' + newest.cover : undefined,
            tag: 'afnjp-news', // 同じタグの通知は積み上がらず置き換わる
            renotify: true,
            data: { url: `./posts/${newest.id}.html` },
        });

        await writeMark(newest.id);
    })());
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || './index.html', self.location.href).href;

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // すでに開いているタブがあれば、それを使い回す
        for (const client of windows) {
            if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                await client.focus();
                if ('navigate' in client) await client.navigate(target).catch(() => { });
                return;
            }
        }
        if (self.clients.openWindow) await self.clients.openWindow(target);
    })());
});

/**
 * 購読が期限切れなどで作り直された場合。
 * 新しい購読を登録し直す（サーバー側の URL はページから渡された設定を使えないため、
 * ここでは同一オリジンの push-config.json を読む）。
 */
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil((async () => {
        try {
            const cfg = await fetch('./push-config.json', { cache: 'no-store' }).then(r => r.json());
            if (!cfg.enabled || !cfg.endpoint) return;

            const base = cfg.endpoint.replace(/\/+$/, '');
            const publicKey = cfg.publicKey
                || (await fetch(base + '/key').then(r => r.json())).publicKey;
            if (!publicKey) return;

            // base64url の公開鍵を Uint8Array に直す（subscribe が要求する形）
            const pad = '='.repeat((4 - publicKey.length % 4) % 4);
            const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));

            const sub = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)),
            });
            await fetch(`${base}/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub),
            });
        } catch { /* 次に本人が購読ボタンを押したときに復帰する */ }
    })());
});
