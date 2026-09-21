# AFNJP — AI Frontier News JP 公式サイト

Discord コミュニティ「AI Frontier News JP」の公式ランディングページ。
海外の AI ニュースを一次情報から確認し、出典リンク付きの日本語記事として配信するコミュニティの入口です。

- **公開サイト**: https://rei0623.github.io/AFNJP/ (GitHub Pages / main ブランチ直下から配信)
- **Discord**: https://discord.gg/WUWE6Ev7yh
- **X (Twitter)**: https://x.com/AI_FrontierNews

## 構成

```text
index.html            サイト本体(単一ファイル。CSS/JS 同梱)
archive.html          記事アーカイブの一覧(自動生成)
posts/<id>.html       個別記事ページ(自動生成)
manifest.webmanifest  ホーム画面に追加するための設定(PWA)
sw.js                 Service Worker。オフライン閲覧とプッシュ通知の受け口
push-config.json      プッシュ通知の公開設定(公開鍵と Worker のURL。秘密は入れない)
push-worker/          プッシュ配信用の Cloudflare Worker(サイトからは配信されない)
posts.json            最新記事データ(Bot が毎時自動生成)
posts-archive.json    過去記事の蓄積。追記のみで消さない(Bot が毎時自動生成)
channels.json         チャンネル構成データ(Bot が毎時自動生成)
assets/posts/         記事カバー画像。640px 幅の WebP(Bot が毎時自動生成)
assets/article.css    記事ページ / アーカイブ一覧の共通スタイル(手で編集する)
package.json          生成スクリプトの依存(sharp のみ)。サイト本体は依存を持たない
scripts/
  sync-discord.mjs    Discord API からデータを同期するスクリプト
  tag-posts.mjs       記事に「発表の種類」のタグを付ける(archive.html の絞り込み用)
  generate-seo.mjs    記事ページ・一覧・静的化・feed / sitemap を生成
  post-x-drafts.mjs   新着記事の X 投稿用の下書きを #x-下書き へ送る
  post-to-x.mjs       #x-下書き で ✅ が付いた下書きだけを X へ投稿する
  notify-push.mjs     新着があれば Worker を叩いてプッシュ通知を送る
  web-watch.mjs       各社の公式ブログの新着を拾い #一次情報ウォッチ へ流す
  lib/oauth1.mjs      X 投稿に使う OAuth 1.0a 署名(node:crypto のみ)
  lib/jev.mjs         Jev(判断だけを返すモデル)への薄いラッパ。鍵が無ければ何もしない
  lib/text.mjs        文を途中で切らずに切り詰める処理
  lib/*.test.mjs      署名と切り詰めの検証(npm test)
watch-sources.json    公式ブログの監視先(手で編集する)
.github/workflows/
  update-channels.yml 毎時 :17 (UTC) に同期と静的化を実行するワークフロー
  web-watch.yml       5分ごとに公式ブログの新着を見にいくワークフロー
feed.xml              最新記事の RSS フィード(自動生成)
sitemap.xml           検索エンジン向けサイトマップ(自動生成。全記事ページを収録)
404.html              Not Found ページ
llms.txt              AI エージェント向けの補助的なサイト案内(実験的)
.nojekyll             GitHub Pages の Jekyll 処理を無効化(静的ファイルをそのまま配信)
```

## データフロー

```text
Discord (フォーラムチャンネル)
   │  毎時 :17 UTC — GitHub Actions (update-channels.yml)
   ▼
scripts/sync-discord.mjs
   │  posts.json / posts-archive.json / channels.json / assets/posts/ を更新
   ▼
scripts/generate-seo.mjs
   │  index.html のマーカー区間 / posts/<id>.html / archive.html /
   │  feed.xml / sitemap.xml を更新してコミット
   ▼
GitHub Pages (main ブランチ) ── HTML に記事が入った状態で配信され、
                               ブラウザでは JS が最新データで置き換える
```

メンバー数などの統計は、ブラウザから Discord の invite API を直接参照して表示しています。
統計値やチャンネル件数の表示は live な値のため静的化しておらず、JavaScript が必要です。

## 開発ルール

- `posts.json` / `posts-archive.json` / `channels.json` / `assets/posts/` / `archive.html` / `posts/` は **Bot が自動生成するため手動編集しない**(編集しても毎時の同期で上書きされ、競合の原因になります)
- `index.html` の **`POSTS` / `CHANNELS` / `ARCHIVE` の3組のマーカー区間も毎時自動生成される**ため手動編集しない。マーカーの外側は自由に編集できます(生成スクリプトは区間の外を1文字も変更しません)
- 記事ページの見た目を変えるときは `assets/article.css` を編集する。色のトークン名は `index.html` の `:root` と揃えてあるので、色を変えるときは両方を直すこと
- `.github/workflows/` は Discord Bot トークンを使用するため、**変更前にオーナー(@rei0623)へ連絡する**
- 変更は **ブランチ → Pull Request** で行う(main は force push / ブランチ削除が禁止されています)

## SEO 上の設計メモ

- **robots.txt は置いていない**: GitHub Pages のプロジェクトサイトでは robots.txt はホストルート(`rei0623.github.io/robots.txt`)にしか置けず、このリポジトリからは制御できないため。robots.txt が無い状態はクローラー全許可であり、現状はそれで問題ない
- **sitemap.xml** は Google Search Console / Bing Webmaster Tools へ手動送信する(プロジェクトサイトでは robots.txt の Sitemap 行が使えないため)
- **記事一覧とチャンネル一覧は静的化済み**: ChatGPT / Claude / Perplexity のクローラー(GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot)は JavaScript を実行しないため、JS で描画していた一覧はこれらから読めなかった。`generate-seo.mjs` が毎時 HTML へ書き込むことで解決している(Googlebot / Bingbot は JS を実行するので元から読めていた)
- **個別記事ページ(`posts/<id>.html`)**: 記事1本が1URLになるので、記事が増えるほど検索対象のページが積み上がる。**本文は転載しない** —— リード(先頭の段落)・小見出しの一覧・一次情報への出典リンクだけを載せ、全文と議論は Discord へ誘導する。トップのカードとアーカイブ一覧からリンクされ、`sitemap.xml` にも全件が入る
- **記事アーカイブ(`posts-archive.json`)**: Discord のアクティブスレッド一覧から記事が外れても、サイト側では消えないようにするための蓄積。**追記のみ**で、ここに残っている記事のカバー画像も削除されない
- **feed.xml(RSS)の位置づけ**: 最新記事を機械可読な形で配信することが目的。リンク先は現時点では Discord のスレッド
- **FAQPage JSON-LD** は可視 FAQ と文字列レベルで一致させている。Google の FAQ リッチリザルトは 2026-05 に廃止済みで検索結果の見た目には効かないが、JS を実行しない AI クローラーにとって機械可読な情報源になるため置いている。**可視 FAQ の文言を変えたら JSON-LD 側も必ず同時に直すこと**

## 生成スクリプトの運用

`scripts/generate-seo.mjs` は Discord Bot トークンを使わず、`posts.json` / `posts-archive.json` / `channels.json` を読むだけです。

壊れた HTML を公開しないための安全策:

- マーカーがちょうど1組ずつ存在しない場合は**何も書かずに終了**する
- 生成内容の構造(カード数・カテゴリ数・閉じタグ・制御文字・XML の妥当性・記事ページと sitemap の件数の一致)を検査し、通らなければ**1ファイルも書かない**
- マーカー区間の外側が1文字も変わっていないことを検証する
- ワークフローでは `continue-on-error: true` にしてあるため、静的化が失敗しても Discord データの同期は止まらない

**ロールバック手順**: `update-channels.yml` から `Generate static HTML and feeds` ステップを取り除けば次回実行から停止します。`index.html` は直前のコミットへ revert してください。

## 一次情報ウォッチ(公式ブログの新着監視)

各社の公式ブログを見張り、新しい投稿が出たら Discord の `#一次情報ウォッチ`(運営専用)へ流します。
**記事を書く前に「発表があったこと」を掴む**のが目的です。

```text
GitHub Actions(5分ごと) ─ scripts/web-watch.mjs
   ├ rss     … フィードがある会社。タイトルと日付がそのまま取れる
   ├ sitemap … フィードが無い会社。新しく現れた URL を検出しタイトルを取りに行く
   ├ 既読URLは Cloudflare KV に保存(リポジトリにはコミットしない)
   └ 新着 → Discord へ投稿
```

**未公開ページ(リーク)は狙いません。** 「一次情報を確認して書く」という運営方針に沿わせるための線引きで、
sitemap を使う場合も `include` でブログ記事のパスだけに絞っています。

### 記事化ずみかの表示

`posts-archive.json` の出典URLと突き合わせ、その発表を AFNJP で既に記事にしたかを出します。

```text
🔴 未記事化          … まだ書いていない
🟡 記事化ずみかも    … URL は違うが、同じ発表の記事が見つかった(記事リンクを添える)
✅ 記事化ずみ        … もう書いてある
```

検知の時点ではまず未記事化なので、**このチャンネルがそのまま「まだ書いていない発表」の一覧**になります。

判定は2段構えです。

1. **URL の一致**。記事の参考文献に挙がっている URL を**全部**突き合わせます。
   同じ発表が `deepmind.google` と `blog.google` のように別ドメインで出ても、
   記事が両方を挙げていればここで一致します
2. それでも一致しないものだけ、Jev に「同じ発表を書いた記事がアーカイブにあるか」を問います。
   見つかっても ✅ にはせず 🟡 に留め、記事へのリンクを添えるだけにします。
   ここを外すと、**まだ書いていない発表がこの一覧から消えてしまう**ためです

`node scripts/web-watch.mjs --judge 30` で、この判定が当たるかを実データで測れます
(アーカイブの記事を「新着」に見立てて、その記事自身を見つけられるかを見る)。
現状は 30件中 正解29 / 見つけられず1 / 誤り0 です。Discord にも状態にも触りません。

### 重要度などの目印

同じ呼び出しで重要度・AI関連か・噂か・国内関連かも取り、見出しに目印を付けます。
**投稿自体は止めません**(発表を取りこぼさないため)。

```text
🔥 重要度が高い    🗣 噂・観測の可能性    🔇 AI以外の内容に見える    🔈 重要度が低い
```

`TYPESAFE_API_KEY` が未設定なら、この判定は行われず従来どおりの表示になります。

### 監視先

`watch-sources.json` で定義しています。現在17ソース。

```bash
node scripts/web-watch.mjs --dry-run   # 各ソースが実際に取れるかを確認する
node scripts/web-watch.mjs --volume    # 各ソースが1日何件出しているかを見る
```

監視先を足したら、必ず `--dry-run` を通してから入れてください。サイト側の作りが変わると黙って0件になります。

**大手は製品ごとにブログが分かれています。** Microsoft は Copilot / 365 / Research / DevBlogs / Azure、
Google は blog.google / DeepMind / Developers / Research / Cloud、Anthropic は anthropic.com と claude.com が別です。
1社1フィードのつもりでいると取りこぼします。

`--volume` の読み方に注意:
**RSS の数字は公開日ベースなので信用できます**が、**sitemap の数字は水増しされます**。
`lastmod` はサイト全体の再ビルドで一斉に動くことがあり、その日に出た記事の数にはなりません
(ElevenLabs が 57 件/日 と出るのはこれ)。実際の検知は URL の差分で行うので、通知量はこの数字より少なくなります。

対象外にしているものと、その理由も同じファイルに書いてあります(`_未対応`)。
**x.ai は Cloudflare のbot対策で 403 を返しますが、回避はしません。**

### 運用上の注意

- **初回の実行は投稿しません。** その時点の記事をすべて既読として登録するだけです。これをしないと過去記事が数千件流れます
- 1回の実行で投稿するのは最大12件(暴発の歯止め)
- Bot には投稿先チャンネルでの **「メッセージを送信」権限**が必要です。プライベートチャンネルの場合、サーバー全体の閲覧権限だけでは入れないので、チャンネル個別に Bot を追加してください
- GitHub Actions のスケジュールは混雑時に5〜15分遅れることがあります。体感が遅ければ、Worker の cron で更新有無だけを見て Actions を起こす二段構えに変えられます

## X への投稿(半自動 ─ 現在は無効)

> **現状: 自動投稿は有効にしていません。X API が有料のためです（2026-08 に判断）。**
>
> X は 2026年2月に無料枠を廃止し、前払いクレジットの従量課金になりました。
> 公式の料金は **URL を含む投稿が $0.200/件**(URL なしは $0.015/件)。
> AFNJP の下書きは必ず記事リンクを含むため、すべて $0.200 の側に当たります。
>
> 記事の投稿ペースは 1日平均 6.7本(2026-08-13〜19 の実測)＝月およそ 200本。
> 全部流すと **月 $40 前後**。1日2〜3本に絞れば月 $12〜18。
>
> このコストに見合わないと判断し、**Discord の下書きを人がコピペする運用のまま**にしています。
> コードは入っているので、鍵を登録すればいつでも有効化できます。
> **鍵を登録しない限り、投稿は一切行われません**(`post-to-x.mjs` は何もせず正常終了する)。

「人が確かめてから出す」という原則を崩さないため、有効にする場合も**完全自動投稿にはしません**。

```text
新着記事 → post-x-drafts.mjs → Discord #x-下書き に下書きが流れる
                                      │
                                      │  人が読んで ✅ を付ける（＝承認）
                                      ▼
                               post-to-x.mjs → X へ投稿 → 🚀 が付く
```

- ✅ を付けなければ**何も投稿されません**。誤りに気づいたら承認しなければよいだけです
- 投稿済みの下書きには 🚀 が付き、`.x-posted.json` にも記録されるので二重投稿しません
- 1回の実行で投稿するのは最大3件(事故ったときに連投しないための歯止め)
- 下書きのリンク先は**サイトの記事ページ**です。X ではサイトの OGP カードが出て、そこから Discord へ進めます

### 有効にする手順(将来やる場合)

まず **X の課金設定**が必要です(無料枠がないため)。そのうえで、
`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` の4つを
リポジトリの Settings > Secrets and variables > Actions に登録すると動きだします。
**1つでも欠けていると `post-to-x.mjs` は何もせず正常終了する**ので、
登録するまでは今までどおり手動でのコピペ運用が続きます。

有効にするなら、`MAX_PER_RUN`(既定3)を下げて日次の投稿数、つまり課金額に
上限をかけておくことを勧めます。

X 側で必要な設定:

1. [X Developer Portal](https://developer.x.com/) でアプリを作る
2. User authentication settings で **App permissions を Read and write** にする
3. Keys and tokens から API Key / Secret と Access Token / Secret を発行する
   (権限を Read and write に変えた**後**に Access Token を再発行すること。
   変更前に発行したトークンは読み取り専用のままです)

OAuth 1.0a の署名は `scripts/lib/oauth1.mjs` に自前で実装しています(依存を増やさないため)。
`npm test` で、X 公式ドキュメントに載っている既知の署名例と一致することを確認できます。

## 更新の受け取り方(PWA / RSS / プッシュ通知)

Discord に入りたくない人でもサイト側で新着を追えるようにするための仕組みです。
トップの「更新を受け取る」ブロックにまとまっています。

| 手段 | 状態 | 必要なもの |
|---|---|---|
| RSS (`feed.xml`) | 有効 | なし |
| ホーム画面に追加(PWA) | 有効 | なし |
| プッシュ通知 | **無効(要設定)** | Cloudflare アカウント |

### PWA

`manifest.webmanifest` と `sw.js` で、ホーム画面に追加するとアプリのように起動し、
一度開いた記事はオフラインでも読めます。

キャッシュ方針は `sw.js` の冒頭に書いてあります。要点は
**HTML と JSON はネットワーク優先**(記事が毎時更新されるため)、
**CSS と画像はキャッシュ優先**(画像のファイル名は記事IDなので中身が変わらない)。

`sw.js` の `VERSION` を上げると、次の訪問で古いキャッシュが破棄されます。
配信するファイルの構成を変えたときは上げてください。

### プッシュ通知

**通知はペイロードを持ちません。** 「新着があった」という合図だけを送り、
文面はブラウザ側の `sw.js` が `posts.json` を読んで組み立てます。
本文を載せると購読者ごとに暗号化が必要になり、Cloudflare Workers 無料枠の
CPU 制限(10ms/リクエスト)に収まらないためです。
副次的な利点として、**通知の文面はサーバーを触らずに変えられます**。

```text
ブラウザ ──購読──▶ Cloudflare Worker ──▶ Workers KV(購読者を保存)
                          ▲
毎時の GitHub Actions ─────┘  新着があれば /notify を叩く
   scripts/notify-push.mjs      Worker が各ブラウザへプッシュ
                                       │
                                       ▼
                              sw.js が posts.json を読んで通知を表示
```

**注意: iPhone はホーム画面に追加した場合のみ通知が届きます**(Safari のタブのままでは届かない)。
Android と PC の Chrome / Edge / Firefox は通常のタブでも届きます。

#### 有効にする手順

1. **VAPID の鍵ペアを作る**(自分の手元で。秘密鍵を他人に渡さないこと)

   ```bash
   npx web-push generate-vapid-keys
   ```

2. **Worker をデプロイする**

   ```bash
   cd push-worker
   npx wrangler login
   npx wrangler kv namespace create SUBS   # 出力された id を wrangler.toml に貼る
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT    # mailto:あなたのメール
   npx wrangler secret put SEND_TOKEN       # 自分で決めた長いランダム文字列
   npx wrangler deploy
   ```

3. **`push-config.json` を編集する**(公開鍵と Worker の URL。どちらも公開情報)

   ```json
   {
     "enabled": true,
     "endpoint": "https://afnjp-push.<あなた>.workers.dev",
     "publicKey": "<VAPID の公開鍵>"
   }
   ```

4. **GitHub Secrets に `PUSH_SEND_TOKEN`** を登録する(手順2の `SEND_TOKEN` と同じ値)

**秘密鍵と SEND_TOKEN は絶対にリポジトリに置かないこと。**
`push-config.json` に入れてよいのは公開鍵と Worker の URL だけです。

設定が1つでも欠けている間は `scripts/notify-push.mjs` が何もせず正常終了し、
サイト側の通知ボタンも表示されません。

#### 費用

Cloudflare Workers 無料枠は 10万リクエスト/日、KV は 読み10万/日・書き1,000/日・1GB。
購読1件につき KV 書き込み1回、通知1回につき購読者数ぶんの読み取りと送信です。
**Workers のサブリクエスト上限が 50/リクエスト**のため、`/notify` は45件ずつ処理し、
`notify-push.mjs` がカーソルで残りを回します。

## カバー画像の扱い

`sync-discord.mjs` は取り込んだ画像を **640px 幅 / WebP(quality 72)** に変換してから保存します。

変換前の実測では 12 枚で 4.27MB(最大 1.7MB の PNG)あったものが、変換後は合計 99KB になりました。
記事は毎時コミットされるため、元サイズのまま置くと git 履歴が記事数に比例して膨らみます
(実際、対策前の8日間で `.git` は 55MB → 78MB に増えていました)。

- 同じ記事の画像がすでにディスクにあれば再取得しない(毎時の無駄なダウンロードと再エンコードを避ける)
- 変換に失敗した画像は**取り込みを諦める**。巨大な元画像をそのまま置くよりは画像なしのほうがましという判断
- 削除されるのは「アーカイブのどの記事からも参照されていない画像」だけ

## 記事の絞り込み(archive.html)

記事には「発表の種類」のタグが付きます。企業名(`category`)は Discord のチャンネル構成から
そのまま取れるので、コードでは出せない**種類**のほうを `scripts/tag-posts.mjs` が判定します。

```text
モデル公開 / 機能追加 / 研究・評価 / 開発者向け / 企業動向 / 規制・方針 / 導入事例 / その他
```

一覧の絞り込みは **JavaScript を使いません**。ラジオボタンと `:checked` だけで切り替えます。
GPTBot / ClaudeBot などは JS を実行しないため、JS で行を出し入れすると一覧が読めなくなります。
CSS で隠すだけなら HTML には全記事が載ったままなので、クローラーからは今までどおり全件が見えます。

タグは一度付けたら推論し直しません(記事は投稿後に書き換わらない運用のため)。
初回の208件で $0.008、以後は新着ぶんだけです。

```bash
node scripts/tag-posts.mjs --dry-run   # 何件が対象で、いくらかかるかを見る
node scripts/tag-posts.mjs             # kind の無い記事にタグを付ける
node scripts/tag-posts.mjs --retag     # 分類を変えたときに全件付け直す
```

## Jev(判断だけを返すモデル)の使いどころ

`TYPESAFE_API_KEY` があるときだけ動きます。**無ければ全部スキップされ、挙動は導入前と同じ**です
(`post-to-x.mjs` の X 鍵と同じ扱い)。

| どこ | 何を判断させているか |
|---|---|
| `web-watch.mjs` | 同じ発表の記事がアーカイブにあるか / 重要度・噂か・AI関連か |
| `tag-posts.mjs` | 記事の「発表の種類」 |
| `post-x-drafts.mjs` | 下書きの要約が途中で切れていないか / 記事より強く読めないか |

方針(載せる・止める)は必ずコード側が持ちます。モデルには「同じ発表か」「どの種類か」
といった**答えが一意に決まる判断**だけを渡し、その生の値をどう使うかはコードで書きます。
こうしておくと、基準を変えても推論をやり直さずに済みます。

### 費用

入力 $0.042 / 1M トークン、出力は無料。**無料枠はありません**
(「無料」と言われるのは出力トークンと Playground のこと)。

実測で1件あたり約 1,400 トークン ＝ **$0.00006**。

| 何 | 費用 |
|---|---|
| 記事208件への初回タグ付け | $0.008(一度きり) |
| 新着1件の判定(ウォッチ / タグ / 下書き下読み) | $0.00006 |
| 毎時の運用(記事 1日6.7本 + ウォッチ) | **月 $0.2 程度** |

X API の月$40と比べる話にはなりません。抑えどころは金額より**呼び出し回数**で、
次の3つで歯止めをかけています。

1. **新着が無ければ1回も呼ばない。** 5分ごとの web-watch は、差分が0件なら Jev に触れません
2. **1回の実行の上限。** `scripts/lib/jev.mjs` の `MAX_CALLS_PER_RUN`(既定40)。
   web-watch はさらに投稿上限12件に縛られます
3. **同じ state への問いは1回にまとめる。** 分けると同じ state を二重に課金します。
   出力は無料なので、問いを増やしても増えるのは state のぶんだけです

## 将来課題(記録)

- アーカイブが数千件規模になったとき、`archive.html` を年ごとに別ファイルへ分割する
  (種類での絞り込みは入れたが、行そのものは1ページに全部載っている)
- `feed.xml` のリンク先を個別記事ページに切り替えるかどうか(現状は Discord のまま)
