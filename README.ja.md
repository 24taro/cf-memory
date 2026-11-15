# cf-memory

コーディングエージェントの記憶を、自分の Cloudflare アカウントに置きます。発言と最終回答を原文のまま残し、キーワードで探します。ベクトルデータベースもモデル呼び出しも使いません。

[English](README.md)

Claude Code や Codex は、昨日決めたことを覚えていません。cf-memory は Cloudflare Worker と小さなフックプラグインの組です。フックが毎ターンを記録し、プロンプトのたびに関連するノートと過去の会話をエージェントの前に戻します。

cf-memory は独立したプロジェクトです。Cloudflare 上で動きますが、Cloudflare, Inc. とは提携しておらず、承認も受けていません。

## 導入

必要なもの: Workers Paid プランの Cloudflare アカウント、Node.js 22 以上、Claude Code か Codex。

```bash
git clone https://github.com/24taro/cf-memory.git
cd cf-memory
./install.sh
```

スクリプトは次のことを行います。

- Cloudflare へのログイン
- D1 データベース 2 つと R2 バケット 1 つの作成
- Worker のデプロイ
- API トークンの生成
- サーバーの応答確認
- Claude Code と Codex への接続(入っている場合)

終わったらエージェントを再起動してください。状態は次のコマンドで確認できます。

```bash
node cf-memory-agent/scripts/agent.mjs doctor
```

更新するときも `./install.sh` をもう一度実行します。データとトークンは残ります。

## 仕組み

1. **記録**: フックが発言とエージェントの最終回答を全文で残します。ツール操作は 1 行、失敗した出力は先頭だけ残します。送る前に手元で秘密情報を伏せます。要約はしません。
2. **想起**: プロンプトのたびにノートとスキルをキーワードで探し、当たったものを差し込みます。セッション開始時にはコアメモリと、同じリポジトリの前回セッションの最後の回答を差し込みます。
3. **検索**: もっと前の文脈が要るとき、エージェントは残した会話そのものを探します(`log_search`、`log_read`)。残す価値のあるものはノートに保存します(`notes_put`)。

検索はキーワードのみです。SQLite FTS5 の trigram 索引を使い、1〜2 文字の語は部分一致で補います。日本語と英語の両方で動きます。

## データの置き場所

すべて自分の Cloudflare アカウントの D1 と R2 に入ります。通信先は自分の Worker だけです。API トークンはこのチェックアウトの `.cf-memory.secrets`(権限 0600、git の対象外)と、エージェントの MCP 設定にあります。

発言と最終回答は消すまで残ります。ツール操作の行とエラーの先頭は 90 日で消えます(`LOG_ACTION_RETENTION_DAYS`)。

## 費用

Workers Paid プランを前提にしています。Free プランは D1 の読み取りが 1 日 500 万行までで、作者自身の利用では多い日に約 800 万行を読みました。Free プランでは翌日まで応答が止まることがあります。

## そのほか

- [Web 画面(Cloudflare Access)](docs/WEB-ACCESS.md)
- [チームで使う](docs/TEAM-MODE.md)
- [エージェントプラグイン](cf-memory-agent/README.md)
- [セキュリティ](SECURITY.md)

## ライセンス

[MIT](LICENSE)
