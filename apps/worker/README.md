# Worker

Cloudflare WorkerはDiscordの `/meeting`・`/status`・`/imakinta`・`/meeting_notion_retry` Interaction、voice-gateway向けセッションAPI、Gateway ControlへのWebSocket接続を提供します。

各セッションは `guildId:channelId` で決まるDurable Objectに保存されます。セルフホストの voice-gateway が話者別 WAV chunk を認証付き HTTP で送信し、Worker は `@cf/openai/whisper-large-v3-turbo` で文字起こしします。GPU やローカル文字起こしサーバーは不要です。

音声は推論前に R2 へ保存し、成功した文字起こし結果はセッションの SQLite に保存します。成功後の音声は削除し、推論に失敗した音声は R2 に残します。同じ chunk を同じ区間番号で再送すると保存済み結果を返します。gateway は録音と並行して送信し、各リクエストで結果を受け取ります。Cloudflare Queues は使用しません。最終的な文字起こしと録音メタデータを含む manifest も R2 に保存します。Worker は manifest 用の短命な PUT 署名付き URL を発行し、gateway へ R2 API キーを渡しません。

## Discord設定

コマンド・ボタン・選択操作の処理経路は [`Discord Interaction のフロー図`](../../docs/discord-interaction-flows.md) を参照してください。

Discord Developer PortalのInteraction Endpoint URLを `https://<Workerのホスト>/interactions` に設定します。アプリケーションIDと公開鍵をWorker環境に設定し、`GATEWAY_CONTROL_TOKEN` にはvoice-gatewayと共有するランダムな値を設定します。Gatewayとの接続が切断されて録音が中断された場合、Workerは対象VCのチャットにエラー埋め込みを送信します。そのため、Workerにも `DISCORD_BOT_TOKEN` をsecretとして設定してください。

DiscordコマンドはWorkerのデプロイ後にGitHub Actionsからglobal commandとして登録されます。Workflowで使うため、GitHub Actions secretsに `DISCORD_BOT_TOKEN` を登録してください。アプリケーションIDは `wrangler.jsonc` とGitHub Actionsの設定で同じ値を使います。

ローカルから手動で登録する場合は、`DISCORD_APPLICATION_ID` と `DISCORD_BOT_TOKEN` を環境変数に設定して次を実行します。

```sh
pnpm --filter @ai-meeting-minutes/worker register:commands
```

Botには対象guildへの参加とVoice ChannelのView Channel・Connect権限が必要です。切断エラー埋め込みの送信には対象VCのチャットでSend Messages権限も必要です。コマンドは対象VCのチャット内で入力します。`/meeting` で Notion を選び、DB と親ページを選択すると録音が始まります。DB 選択時に継続利用を有効にすると、そのVCの次回以降は前回と同じ DB の会議ページ一覧から録音先を選べます。録音中のメッセージにある「録音を終了」ボタンで録音を停止できます。`/imakinta` は確定した文字起こしをWorkers AIで要約します。WorkerはInteractionの `channel_id` を使って対象VCを決めます。

`/status` は録音中・処理中のセッション、または直近のセッションとNotion保存状態に加えて、Workerから見たGatewayの接続状態を表示します。

`/meeting_notion_retry` は直近の完了セッションでNotion保存が失敗した場合に、ページ更新を再試行します。

`/imakinta` はWorkerがセッションのSQLiteに保存済みの文字起こしを読み、要約とDiscordへの返信まで処理します。再開したセッションでは、再開前の確定済み文字起こしも対象に含みます。Gatewayへの制御コマンドは送信しません。

## Notionへの保存

Notion向けの議事録要約には、分割要約も含めて `@cf/google/gemma-4-26b-a4b-it` を使用します。`/imakinta` は `@cf/qwen/qwen3-30b-a3b-fp8` を使用します。どちらも思考モードを無効にしています。

`/meeting` で選択したNotion親ページの下に「AI議事録」を作成し、Discordにリンクを返します。同じ親項目で次の会議を開始すると既存の「AI議事録」ページを再利用します。同じVCで停止後10分以内に `/meeting` から同じ親項目を選ぶと、完了したセッションを再開し、前後の録音を同じ文字起こしにまとめます。セッション完了後、WorkerはR2のmanifestからWorkers AIで要約を作り、会議情報・要約・全文字起こしをそのページに反映します。開始時にNotionページを作成できなくても録音は続き、セッション完了後に作成または既存ページの検索を再試行します。DOはNotion出力の状態・試行回数・直近の失敗理由を保存し、最終出力に失敗した場合は初回を含め最大5試行します。AI要約に失敗した場合も全文字起こしを含むページを保存します。Notionへの保存が失敗した場合もセッションは完了扱いのままになり、manifestはR2に残ります。エラーはWorkerのログとセッション状態に記録されます。

1. Notion Developer Portalでinternal connectionを作成し、`Read content`、`Insert content`、`Update content` の権限を付けます。
2. 対象の議事録データベースにconnectionを追加します。WorkerがDB内の項目を検索し、選択項目の下にAI議事録ページを作成します。
3. `/meeting` からNotionへの保存を選び、会議ごとに使うデータベースと親ページを選択します。

子ページの本文にはsession情報、要約、全文字起こしが入ります。

生成した議事録のMarkdownはR2に保存し、Notionへの更新だけが失敗した場合は再試行で再利用します。再開後にmanifestが変わった場合は、その内容に対応する議事録を生成します。

## ローカル開発

1. `pnpm exec wrangler r2 bucket create ai-meeting-minutes-recordings` でR2 bucketを作成します。
2. `.dev.vars.example` を `.dev.vars` にコピーし、Cloudflare account IDと、対象bucketへの書き込み権限を持つR2 API認証情報を設定します。
3. `GATEWAY_API_TOKEN` に十分長いランダム値を設定します。同じ値をvoice-gatewayの `WORKER_API_TOKEN` に設定します。
4. Workers AI bindingは `wrangler.jsonc` で設定済みです。ローカル開発でもCloudflare上のAI bindingを使います。
5. `pnpm --filter @ai-meeting-minutes/worker dev` でWorkerを起動します。

voice-gateway側は [`../voice-gateway/.env.example`](../voice-gateway/.env.example) を `.env` にコピーして設定できます。

`.dev.vars` はGit管理対象外です。実環境では `GATEWAY_API_TOKEN`、`GATEWAY_CONTROL_TOKEN`、`DISCORD_APPLICATION_PUBLIC_KEY`、`DISCORD_BOT_TOKEN`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`NOTION_API_TOKEN` をWrangler secretsとして登録してください。`DISCORD_APPLICATION_ID` はWorkerの環境変数として設定します。R2 bucket名は `wrangler.jsonc` の `R2_BUCKET_NAME` と `RECORDINGS` bindingで指定します。

gatewayとWorkerのHTTP契約は [`../../contracts/openapi.yaml`](../../contracts/openapi.yaml) にあります。

## GitHub Actionsからのデプロイ

`main` へのpush後、CIが成功するとWorkerをCloudflareへデプロイします。GitHubリポジトリのActions secretsに `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を登録してください。API tokenは対象アカウントに限定し、Workers Scriptsの編集権限を付与します。

Workerの実行時secretやR2などのCloudflareリソースは、事前に本番環境へ設定してください。このworkflowはCloudflare Workerをデプロイします。voice-gateway はセルフホストし、[`../voice-gateway/README.md`](../voice-gateway/README.md) の Compose 手順で起動します。この workflow は gateway をデプロイしません。
