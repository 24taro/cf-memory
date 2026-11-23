# cf-memory

コーディングエージェントの記憶を、自分の Cloudflare アカウントに置きます。発言と最終回答を原文のまま残し、キーワードで探します。ベクトルデータベースもモデル呼び出しも使いません。

[English](README.md)

Claude Code や Codex は、昨日決めたことを覚えていません。cf-memory は Cloudflare Worker と小さなフックプラグインの組です。フックが毎ターンを記録し、プロンプトのたびに関連するノートと過去の会話をエージェントの前に戻します。

cf-memory は独立したプロジェクトです。Cloudflare 上で動きますが、Cloudflare, Inc. とは提携しておらず、承認も受けていません。

初回リリースのサポート対象は、固定 API トークンを使う単一オーナー構成です。[チームモード](docs/TEAM-MODE.md) は実験的な機能です。

## 導入

R2 を有効にした Workers Paid プランの Cloudflare アカウント、Git、Bash、Node.js 22.12 以降の 22.x または 24 以上と npm、OpenSSL、curl が必要です。エージェントを接続する場合は Claude Code 2.1.327 以降か Codex を用意します。インストーラーはデプロイやクライアント設定の変更前に Claude Code のバージョンを確認します。旧版が入っている場合は先に更新してください。Worker だけをデプロイする場合は `./install.sh --no-client` を使います。

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

インストーラーは MCP 登録とフック導入の結果を個別に表示します。一方のクライアントで失敗しても、もう一方の設定を続けてからエラーで終了します。

Codex を使う場合は、インストーラーが表示する `export` 2 行をシェルの設定ファイルに追加し、反映してから Codex を起動してください。`/hooks` で cf-memory のフック4件を承認します。更新後に再承認を求められた場合も、同じ画面で確認して承認してください。

動作を確認するには、テスト用の情報を伝え、最終回答で復唱させます。同じ Git リポジトリで新しいセッションを開き、その情報を尋ねてください。接続とフックの状態は次のコマンドで確認できます。

```bash
node cf-memory-agent/scripts/agent.mjs doctor
```

更新するときは同じチェックアウトで最新の変更を取り込み、`./install.sh` をもう一度実行します。同じ Cloudflare アカウントを使い、`.cf-memory.secrets` を残しておくと、既存のデータベース、バケット、トークンを再利用します。

## 仕組み

1. **記録**: フックが発言とエージェントの最終回答を全文で残します。ツール操作は 1 行、失敗した出力は先頭だけ残します。送る前に手元で秘密情報を伏せます。要約はしません。
2. **想起**: プロンプトのたびにノートとスキルをキーワードで探し、当たったものを差し込みます。セッション開始時にはコアメモリと、同じリポジトリの前回セッションの最後の回答を差し込みます。
3. **検索**: もっと前の文脈が要るとき、エージェントは残した会話そのものを探します(`log_search`、`log_read`)。残す価値のあるものはノートに保存します(`notes_put`)。

検索はキーワードのみです。SQLite FTS5 の trigram 索引を使い、1〜2 文字の語は部分一致で補います。日本語と英語の両方で動きます。

## データの置き場所

フックは会話データを自分の Worker に送信します。会話データは自分の Cloudflare アカウントの D1 に、スキルの添付ファイルは R2 に保存されます。Web 画面は Google Fonts を読み込み、ノート内に外部画像があればその配信元にも接続します。インストーラーは API トークンをこのチェックアウトの `.cf-memory.secrets`（権限 `0600`、Git の対象外）に保存します。

### 会話ログを削除する

発言と最終回答に自動削除期限はありません。日次処理は `LOG_ACTION_RETENTION_DAYS`（既定は90日）より古いツール操作とエラーの抜粋を削除します。個別の会話ログは D1 で管理します。

1. 作業中は接続済みのクライアントを終了し、ローカルキューの `~/.cf-memory/v3/spool/`（または `$CF_MEMORY_AGENT_HOME/spool/`）を確認します。このプロファイルの両クライアントについて、送信待ち・保留・拒否済みのログをすべて破棄する場合は、再起動前に `spool` ディレクトリを削除してください。送信待ちのログが残っていると、再びアップロードされることがあります。新規記録と送信を止めるには `CF_MEMORY_LOG_ENABLED=false` を設定します。
2. `log_search` で対象のエントリIDを確認します。Cloudflare で `LOGS` バインディングの D1 データベース（既定は `cf-memory-logs`）のコンソールを開き、先に `SELECT` を実行します。`123` を確認した行IDに置き換えてから `DELETE` を実行してください。検索インデックスからも該当行が削除されます。

   ```sql
   SELECT rowid, user_id, client, kind FROM log_entries WHERE id = '<entry-id>';
   DELETE FROM log_entries WHERE rowid = 123 AND id = '<entry-id>';
   ```

   この操作の対象は稼働中のデータベースです。[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、バックアップ、別途保存したノートにはコピーが残る場合があります。

## 費用

Workers Paid プランを前提にしています。Free プランは D1 の読み取りが 1 日 500 万行までで、作者自身の利用では多い日に約 800 万行を読みました。Free プランでは翌日まで応答が止まることがあります。

## アンインストール

導入したクライアントのコマンドを実行して、エージェントの接続を解除します。

```bash
node cf-memory-agent/scripts/agent.mjs uninstall --client claude-code
claude mcp remove cf-memory --scope user

node cf-memory-agent/scripts/agent.mjs uninstall --client codex
codex mcp remove cf-memory
```

Codex の場合は、シェルの設定ファイルから `CF_MEMORY_MCP_URL` と `CF_MEMORY_ACCESS_TOKEN` の `export` 行も削除し、新しいシェルを開いてください。ローカルの送信待ちログと診断データは `~/.cf-memory/v3` に残ります。

Cloudflare 上のインスタンスとデータを完全に削除する場合は、導入先のアカウントを選び、次のコマンドを実行してください。

```bash
npx wrangler delete
npx wrangler d1 delete cf-memory
npx wrangler d1 delete cf-memory-logs
npx wrangler r2 bucket delete cf-memory-bundles
```

R2 バケットにオブジェクトがある場合は、先に空にしてください。Cloudflare Access や独自ドメインを設定した場合は、Cloudflare 側の関連設定も削除してください。API トークンが不要になったら、チェックアウトの `.cf-memory.secrets` を削除します。

## そのほか

- [Web 画面(Cloudflare Access)](docs/WEB-ACCESS.md)
- [チームで使う（実験的機能）](docs/TEAM-MODE.md)
- [エージェントプラグイン](cf-memory-agent/README.md)
- [セキュリティ](SECURITY.md)

## ローカル開発

2つのローカル D1 にマイグレーションを適用し、開発専用トークンを作成してから Wrangler を起動します。

```bash
npm ci
npm run db:apply:local
npm run db:logs:apply:local
if [ ! -e .dev.vars ]; then
  (umask 077; printf 'API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars)
fi
npm run dev
```

別のターミナルから操作CLIを使う場合は、標準入力でトークンを渡します。トークンは所有者だけが読めるCLI設定に保存されます。

```bash
sed -n 's/^API_TOKEN=//p' .dev.vars |
  npm run --silent cli -- login --url http://localhost:8787 --key-stdin
npm run --silent cli -- whoami
```

## ライセンス

[MIT](LICENSE)
