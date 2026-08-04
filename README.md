# AFNJP — AI Frontier News JP 公式サイト

Discord コミュニティ「AI Frontier News JP」の公式ランディングページ。
海外の AI ニュースを一次情報から確認し、出典リンク付きの日本語記事として配信するコミュニティの入口です。

- **公開サイト**: https://rei0623.github.io/AFNJP/ (GitHub Pages / main ブランチ直下から配信)
- **Discord**: https://discord.gg/WUWE6Ev7yh
- **X (Twitter)**: https://x.com/AI_FrontierNews

## 構成

```text
index.html            サイト本体(単一ファイル。CSS/JS 同梱)
posts.json            最新記事データ(Bot が毎時自動生成)
channels.json         チャンネル構成データ(Bot が毎時自動生成)
assets/posts/         記事カバー画像(Bot が毎時自動生成)
scripts/
  sync-discord.mjs    Discord API からデータを同期するスクリプト
  generate-seo.mjs    記事一覧・チャンネル一覧を index.html へ静的化し feed / sitemap を生成
.github/workflows/
  update-channels.yml 毎時 :17 (UTC) に同期と静的化を実行するワークフロー
feed.xml              最新記事の RSS フィード(自動生成)
sitemap.xml           検索エンジン向けサイトマップ(自動生成)
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
   │  posts.json / channels.json / assets/posts/ を更新
   ▼
scripts/generate-seo.mjs
   │  index.html のマーカー区間 / feed.xml / sitemap.xml を更新してコミット
   ▼
GitHub Pages (main ブランチ) ── HTML に記事が入った状態で配信され、
                               ブラウザでは JS が最新データで置き換える
```

メンバー数などの統計は、ブラウザから Discord の invite API を直接参照して表示しています。
統計値やチャンネル件数の表示は live な値のため静的化しておらず、JavaScript が必要です。

## 開発ルール

- `posts.json` / `channels.json` / `assets/posts/` は **Bot が自動生成するため手動編集しない**(編集しても毎時の同期で上書きされ、競合の原因になります)
- `index.html` の **`<!-- POSTS:START -->` 〜 `<!-- POSTS:END -->` と `<!-- CHANNELS:START -->` 〜 `<!-- CHANNELS:END -->` の区間も毎時自動生成される**ため手動編集しない。マーカーの外側は自由に編集できます(生成スクリプトは区間の外を1文字も変更しません)
- `.github/workflows/` は Discord Bot トークンを使用するため、**変更前にオーナー(@rei0623)へ連絡する**
- 変更は **ブランチ → Pull Request** で行う(main は force push / ブランチ削除が禁止されています)

## SEO 上の設計メモ

- **robots.txt は置いていない**: GitHub Pages のプロジェクトサイトでは robots.txt はホストルート(`rei0623.github.io/robots.txt`)にしか置けず、このリポジトリからは制御できないため。robots.txt が無い状態はクローラー全許可であり、現状はそれで問題ない
- **sitemap.xml** は Google Search Console / Bing Webmaster Tools へ手動送信する(プロジェクトサイトでは robots.txt の Sitemap 行が使えないため)
- **記事一覧とチャンネル一覧は静的化済み**: ChatGPT / Claude / Perplexity のクローラー(GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot)は JavaScript を実行しないため、JS で描画していた一覧はこれらから読めなかった。`generate-seo.mjs` が毎時 HTML へ書き込むことで解決している(Googlebot / Bingbot は JS を実行するので元から読めていた)
- **feed.xml(RSS)の位置づけ**: 最新記事を機械可読な形で配信することが目的。記事リンク先は Discord であり、**サイト内の記事 URL を増やすものではない**。記事単位の検索資産化には将来の個別記事ページが必要
- **FAQPage JSON-LD** は可視 FAQ と文字列レベルで一致させている。Google の FAQ リッチリザルトは 2026-05 に廃止済みで検索結果の見た目には効かないが、JS を実行しない AI クローラーにとって機械可読な情報源になるため置いている。**可視 FAQ の文言を変えたら JSON-LD 側も必ず同時に直すこと**

## 生成スクリプトの運用

`scripts/generate-seo.mjs` は Discord Bot トークンを使わず、`posts.json` / `channels.json` を読むだけです。

壊れた HTML を公開しないための安全策:

- マーカーがちょうど1組ずつ存在しない場合は**何も書かずに終了**する
- 生成内容の構造(カード数・カテゴリ数・閉じタグ・制御文字・XML の妥当性)を検査し、通らなければ**3ファイルすべて書かない**
- マーカー区間の外側が1文字も変わっていないことを検証する
- ワークフローでは `continue-on-error: true` にしてあるため、静的化が失敗しても Discord データの同期は止まらない

**ロールバック手順**: `update-channels.yml` から `Generate static HTML and feeds` ステップを取り除けば次回実行から停止します。`index.html` は直前のコミットへ revert してください。

## 将来課題(記録)

- 個別記事ページ(`posts/<id>.html`)の自動生成と記事アーカイブの蓄積
- カバー画像のリサイズ / WebP 化と git 履歴肥大への対策
- `sync-discord.mjs` は Discord の active threads が空のとき `posts.json` を空で上書きしカバー画像を全削除する。API の一時障害を空データとして公開しないためのガードを入れる余地がある(静的カードは残るよう対処済み)
