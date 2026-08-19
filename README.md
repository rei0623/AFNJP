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
posts.json            最新記事データ(Bot が毎時自動生成)
posts-archive.json    過去記事の蓄積。追記のみで消さない(Bot が毎時自動生成)
channels.json         チャンネル構成データ(Bot が毎時自動生成)
assets/posts/         記事カバー画像。640px 幅の WebP(Bot が毎時自動生成)
assets/article.css    記事ページ / アーカイブ一覧の共通スタイル(手で編集する)
package.json          生成スクリプトの依存(sharp のみ)。サイト本体は依存を持たない
scripts/
  sync-discord.mjs    Discord API からデータを同期するスクリプト
  generate-seo.mjs    記事ページ・一覧・静的化・feed / sitemap を生成
  post-x-drafts.mjs   新着記事の X 投稿用の下書きを #x-下書き へ送る
  post-to-x.mjs       #x-下書き で ✅ が付いた下書きだけを X へ投稿する
  lib/oauth1.mjs      X 投稿に使う OAuth 1.0a 署名(node:crypto のみ)
.github/workflows/
  update-channels.yml 毎時 :17 (UTC) に同期と静的化を実行するワークフロー
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

## X への投稿(半自動)

「人が確かめてから出す」という原則を崩さないため、**完全自動投稿にはしていません**。

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

### 有効にする手順

`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` の4つを
リポジトリの Settings > Secrets and variables > Actions に登録すると動きだします。
**1つでも欠けていると `post-to-x.mjs` は何もせず正常終了する**ので、
登録するまでは今までどおり手動でのコピペ運用が続きます。

X 側で必要な設定:

1. [X Developer Portal](https://developer.x.com/) でアプリを作る
2. User authentication settings で **App permissions を Read and write** にする
3. Keys and tokens から API Key / Secret と Access Token / Secret を発行する
   (権限を Read and write に変えた**後**に Access Token を再発行すること。
   変更前に発行したトークンは読み取り専用のままです)

OAuth 1.0a の署名は `scripts/lib/oauth1.mjs` に自前で実装しています(依存を増やさないため)。
`npm test` で、X 公式ドキュメントに載っている既知の署名例と一致することを確認できます。

## カバー画像の扱い

`sync-discord.mjs` は取り込んだ画像を **640px 幅 / WebP(quality 72)** に変換してから保存します。

変換前の実測では 12 枚で 4.27MB(最大 1.7MB の PNG)あったものが、変換後は合計 99KB になりました。
記事は毎時コミットされるため、元サイズのまま置くと git 履歴が記事数に比例して膨らみます
(実際、対策前の8日間で `.git` は 55MB → 78MB に増えていました)。

- 同じ記事の画像がすでにディスクにあれば再取得しない(毎時の無駄なダウンロードと再エンコードを避ける)
- 変換に失敗した画像は**取り込みを諦める**。巨大な元画像をそのまま置くよりは画像なしのほうがましという判断
- 削除されるのは「アーカイブのどの記事からも参照されていない画像」だけ

## 将来課題(記録)

- アーカイブが数千件規模になったとき、`archive.html` を年別・カテゴリ別に分割する
- `feed.xml` のリンク先を個別記事ページに切り替えるかどうか(現状は Discord のまま)
