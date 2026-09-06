const siteBase = new URL("../", import.meta.url);

(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const note = $("#subsNote");
  const say = (html) => {
    if (note) note.innerHTML = html;
  };

  /* ── Service Worker ── */
  let swReg = null;
  const swReady = (async () => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      swReg = await navigator.serviceWorker.register(
        new URL("sw.js", siteBase),
      );
      return swReg;
    } catch {
      return null; // 対応していない環境では黙って諦める
    }
  })();

  /* ── ホーム画面に追加 ── */
  let installEvent = null;
  const installBtn = $("#installBtn");

  addEventListener("beforeinstallprompt", (e) => {
    // Chrome は既定のミニバーを出すので、こちらのボタンに置き換える
    e.preventDefault();
    installEvent = e;
    if (installBtn) installBtn.hidden = false;
  });

  installBtn?.addEventListener("click", async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;
    installBtn.hidden = true;
    if (outcome === "accepted")
      say("ホーム画面に追加しました。アイコンから開けます。");
  });

  addEventListener("appinstalled", () => {
    if (installBtn) installBtn.hidden = true;
  });

  /* ── プッシュ通知 ── */
  const pushBtn = $("#pushBtn");
  const pushLabel = $("#pushLabel");

  /** VAPID の公開鍵は base64url。subscribe には Uint8Array で渡す必要がある */
  function toKey(base64url) {
    const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  (async () => {
    if (!pushBtn) return;
    if (!("PushManager" in window) || !("Notification" in window)) return;

    let cfg;
    try {
      cfg = await fetch(new URL("push-config.json", siteBase), {
        cache: "no-store",
      }).then((r) => r.json());
    } catch {
      return;
    }
    if (!cfg?.enabled || !cfg.endpoint) return; // 未設定なら出さない

    // 公開鍵は Worker から取る。ここに書き写さないことで、
    // サーバー側と食い違ったまま気づかない、という事故を防ぐ。
    let publicKey;
    if (!publicKey) {
      try {
        publicKey = (
          await fetch(cfg.endpoint.replace(/\/+$/, "") + "/key").then((r) =>
            r.json(),
          )
        ).publicKey;
      } catch {
        return;
      }
    }
    if (!publicKey) return;
    const checkedKey = toKey(publicKey);
    if (checkedKey.length !== 65 || checkedKey[0] !== 4) return;

    const reg = await swReady;
    if (!reg) return;

    pushBtn.hidden = false;

    const existing = await reg.pushManager.getSubscription();
    let on = Boolean(existing);
    const paint = () => {
      pushLabel.textContent = on ? "通知を停止する" : "通知を受け取る";
    };
    paint();

    if (on) say("新しい記事が出たときに通知が届きます。");

    pushBtn.addEventListener("click", async () => {
      pushBtn.disabled = true;
      try {
        if (on) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            // 先に自分の登録を消してから解除する（解除後は endpoint が取れなくなるため）
            await fetch(cfg.endpoint + "/unsubscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: sub.endpoint }),
            }).catch(() => {});
            await sub.unsubscribe();
          }
          on = false;
          say("通知を停止しました。RSSでも新着を追えます。");
        } else {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") {
            say(
              perm === "denied"
                ? "ブラウザ側で通知がブロックされています。サイトの設定から許可すると受け取れます。"
                : "通知は許可されませんでした。",
            );
            return;
          }
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: toKey(publicKey),
          });
          const res = await fetch(cfg.endpoint + "/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sub),
          });
          if (!res.ok) throw new Error("登録に失敗しました");
          on = true;
          say("登録しました。新しい記事が出たときに通知が届きます。");
        }
      } catch (e) {
        say(
          "うまくいきませんでした。時間をおいて試すか、RSSをご利用ください。",
        );
      } finally {
        paint();
        pushBtn.disabled = false;
      }
    });
  })();
})();
