# AGENTS.md ─ このリポジトリで作業するエージェントへ

AI Frontier News JP (AFNJP) の公式サイトと、それに付随する自動化。
**詳しい仕様は README.md にある。** ここには「知らずに触ると壊すこと」だけを書く。

## 全体像

```text
Discord（記事はここに人が投稿する）
   │  毎時 :17 UTC  update-channels.yml
   ▼
sync-discord.mjs      posts.json / posts-archive.json / 画像を更新
   ▼
generate-seo.mjs      index.html のマーカー区間 / posts/*.html / archive.html
                      / feed.xml / sitemap.xml を生成
   ▼
GitHub Pages（main ブランチ直下から配信）

別系統: 5分ごと  web-watch.yml → web-watch.mjs
        各社の公式ブログの新着を Discord #一次情報ウォッチ へ流す
```

## 絶対に守ること

### 1. 自動生成物を手で編集しない

次のファイルは Bot が毎時上書きする。手で直しても消える。

```text
posts.json  posts-archive.json  channels.json  assets/posts/
posts/*.html  archive.html  feed.xml  sitemap.xml
.x-drafted.json  .x-posted.json  .push-sent.json
```

`index.html` の中でも、**`POSTS` / `CHANNELS` / `ARCHIVE` のマーカー区間は自動生成**。

```html
<!-- POSTS:START 自動生成。この区間は手で編集しないこと -->
...
<!-- POSTS:END -->
```

マーカーの**外側**は自由に編集してよい。生成スクリプトは区間の外を1文字も変えない
(変わっていないことを検証してから書き込む)。

見た目を変えたいときは、生成している側 (`scripts/generate-seo.mjs`) を直す。

### 2. 秘密情報をリポジトリに書かない

| 置き場所 | 中身 |
|---|---|
| GitHub Secrets | `DISCORD_BOT_TOKEN` / `PUSH_SEND_TOKEN` |
| Cloudflare Worker Secrets | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `SEND_TOKEN` |

`push-config.json` に入れてよいのは **Worker の URL だけ**。鍵は入れない
(公開鍵すら書かない。Worker の `/key` から取る)。

過去に VAPID の公開鍵と秘密鍵を取り違えて登録し、`/key` が秘密鍵を公開した事故がある。
以後 `/key` は 65バイト・`0x04` 始まりを検証してからでないと値を返さない。
**公開鍵は87文字で `B` 始まり、秘密鍵は43文字**。

### 3. main に直接コミットしない

main は保護されている。**ブランチを切って PR** にすること。

### 4. リークを狙わない

`web-watch.mjs` が拾うのは**公開済みのブログ記事だけ**。未公開ページ(sitemap にだけ現れる
URL など)は対象外にしている。「一次情報を確認して書く」という運営方針に沿わせるための
線引きで、これは技術的制約ではなく**意図的な判断**。勝手に広げないこと。

同じ理由で、**bot 対策を回避しない**。x.ai が 403 を返すのは既知だが、UA を偽装するなどの
回避はしない方針で対象外にしてある。

## 触る前に走らせるもの

```bash
npm test                                  # OAuth/VAPID・検索/保存・出典抽出・生成の検証
node scripts/generate-seo.mjs             # 生成物を作り直す。検証を通らなければ何も書かない
node scripts/web-watch.mjs --dry-run      # 33ソースが実際に取得できるか
node scripts/web-watch.mjs --volume       # 各ソースが1日何件出しているか
```

`web-watch.mjs` には副作用のないモードがある。**本番の状態を壊さずに試せる**。

| フラグ | 何をするか |
|---|---|
| `--dry-run` | 取得できるかだけ見る。Discord も状態も触らない |
| `--volume` | 流量を数える。同上 |
| `--ping` | テスト投稿を1件出す。状態は触らない |
| `--preview` | 各社の最新1件を本番と同じ見た目で投稿。状態は触らない |

ワークフローの手動実行からも `mode` で選べる (`normal` / `ping` / `preview`)。

## 過去に踏んだ罠

同じところで詰まらないように残す。

**Discord API には専用の User-Agent が要る**
クローラー用の `Mozilla/5.0 (compatible; ...)` を使い回すと 403 (`code 40333`) で弾かれる。
`DiscordBot (URL, version)` 形式でなければならない。`DISCORD_UA` を使うこと。

**sitemap はアルファベット順**
`items[0]` は最新ではない。`<lastmod>` を読んで並べ替える必要がある。
ただし `lastmod` は「最終更新日」であって公開日ではない。サイト全体の再ビルドで
全URLが同じ日時になるところもある (Runway が該当) ので、表示ではそう断っている。

**初回実行では投稿しない**
`web-watch.mjs` も `notify-push.mjs` も `post-x-drafts.mjs` も、初回はその時点の内容を
「既読」として登録するだけ。これをしないと過去記事が数百〜数千件流れる。
**件数を絞って登録してはいけない。** 溢れたぶんが延々と新着として出続ける
(実際に Anthropic の過去記事372件で踏んだ)。

**投稿してから既読にする**
先に既読へ入れると、投稿に失敗したぶんや上限で溢れたぶんが二度と流れない。
必ず「投稿できたものだけ」を既読にする。

**プッシュ通知は1件につき1通・タグを分ける**
同じ `tag` だと通知が積み上がらず置き換わる。記事IDをタグに含めること。

**Service Worker の更新は即時ではない**
`sw.js` を直しても、各端末が次にサイトを開くまで古いものが動く。
テストで「直したはずなのに変わらない」ときはこれを疑う。

## 状態の置き場所

**5分ごとに動くものはリポジトリにコミットしない。** 履歴が使い物にならなくなる。

| 何 | どこ |
|---|---|
| web-watch の既読URL・🔴のまま残っている投稿 | Cloudflare KV (`/watch/state`) |
| プッシュ購読者 | Cloudflare KV |
| 通知ずみ記事ID・X下書きの記録 | リポジトリ (毎時なので許容) |

Worker: `https://afnjp-push.big32on.workers.dev`
`GET /selftest` で鍵まわりが健全か確認できる (真偽値だけ返す。鍵は返さない)。

## 意図的にやっていないこと

**X への自動投稿** — コードは `scripts/post-to-x.mjs` にあるが**無効**。
X API は2026年2月に無料枠を廃止し、**URL付き投稿が $0.200/件**。AFNJP の下書きは必ず
記事リンクを含むため全件が該当し、1日約7本で月$40前後になる。割に合わないと判断した。
鍵を Secrets に入れない限り何も起きない (`post-to-x.mjs` は何もせず正常終了する)。

**Perplexity の監視** — GitHub Actions の実行IPからは 0件が返る (ローカルでは取れる)。
毎回警告が出るが他32ソースは正常なので放置している。

## 埋まっていない穴

- **中国勢と日本国内が弱い。** z.ai / DeepSeek / Sakana AI / Moonshot は RSS も
  sitemap のブログ区画も見つかっていない。HTML を直接読むアダプタが要る
- **Meta AI 本体** (`ai.meta.com`) にフィードが無い。`about.fb.com/news` で代替しているが
  AI 以外の記事も混ざる
- **記事化ずみの判定が甘い。** `posts-archive.json` の `source_url` と突き合わせているが、
  (1) アーカイブが 2026-08-12 以降しかない (それ以前の記事は存在しない)
  (2) 出典が X や GitHub の記事が全体の25%あり、公式ブログのURLと一致しない
  (3) 同じ発表が別ドメインで出る (`deepmind.google` と `blog.google` など)
  → 2026-09-06: `source_urls` に本文・埋め込みの全URLを収集し、監視側も全URLと
  照合するよう修正。既存記事はメタデータの版を見て再取得する。別ドメインの同一発表や
  アーカイブ開始前の記事は、引き続き自動照合できない場合がある
- **Search Console のサイトマップ**が「読み込めませんでした」のまま。
  ファイル側は検証ずみで正常 (application/xml・BOMなし・パース可)

## 生成スクリプトの安全設計

`generate-seo.mjs` は**壊れた HTML を絶対に公開しない**ことを最優先にしている。

- マーカーがちょうど1組ずつ無ければ何も書かずに終了
- 件数・閉じタグ・制御文字・XMLの妥当性・記事ページと sitemap の一致を検査
- **1つでも通らなければ1ファイルも書かない**
- すべて通ってから一時ファイル経由で rename

この設計は崩さないこと。壊れた index.html が本番に出ると、サイト全体が死ぬ。

## 読者向け機能（2026-09-06）

- 共通デザイン: `assets/reader.css`。カード・分類・検索: `assets/reader-core.js`
- 記事・一覧のテンプレート: `scripts/lib/reader-templates.mjs`。編集部の補足: `editorial.json`
- 保存と閲覧履歴はブラウザ内のみ。購読者データや `.push-sent.json` とは別物
- `Sync Discord data` の手動実行で `data_only=true` を選ぶと、Discord投稿・X投稿・
  プッシュ通知をすべてスキップし、過去記事を最大200本再確認する。通常同期は20本ずつ
- CSS変更時はテンプレートの `version` と index.html のアセットURLを更新する。
  `sw.js` の `VERSION` を安易に上げない。通知の重複防止記録が同じキャッシュにある
