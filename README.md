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
.github/workflows/
  update-channels.yml 毎時 :17 (UTC) に同期を実行するワークフロー
sitemap.xml           検索エンジン向けサイトマップ
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
   │  posts.json / channels.json / assets/posts/ を更新してコミット
   ▼
GitHub Pages (main ブランチ) ── ブラウザの JS が posts.json を fetch して記事カードを描画
```

メンバー数などの統計は、ブラウザから Discord の invite API を直接参照して表示しています。

## 開発ルール

- `posts.json` / `channels.json` / `assets/posts/` は **Bot が自動生成するため手動編集しない**(編集しても毎時の同期で上書きされ、競合の原因になります)
- `.github/workflows/` は Discord Bot トークンを使用するため、**変更前にオーナー(@rei0623)へ連絡する**
- 変更は **ブランチ → Pull Request** で行う(main は force push / ブランチ削除が禁止されています)

## SEO 上の設計メモ

- **robots.txt は置いていない**: GitHub Pages のプロジェクトサイトでは robots.txt はホストルート(`rei0623.github.io/robots.txt`)にしか置けず、このリポジトリからは制御できないため。robots.txt が無い状態はクローラー全許可であり、現状はそれで問題ない
- **sitemap.xml** は Google Search Console / Bing Webmaster Tools へ手動送信する(プロジェクトサイトでは robots.txt の Sitemap 行が使えないため)
- **feed.xml(RSS)と記事カードの静的化**は自動生成パイプラインとして検討中(Issue 参照)。RSS の記事リンク先は Discord であり、サイト内の記事 URL を増やすものではない。記事単位の検索資産化には将来の個別記事ページが必要

## 将来課題(記録)

- 個別記事ページ(`posts/<id>.html`)の自動生成と記事アーカイブの蓄積
- カバー画像のリサイズ / WebP 化と git 履歴肥大への対策
