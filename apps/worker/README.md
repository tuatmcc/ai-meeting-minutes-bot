# Worker

Cloudflare WorkerはDiscordの `/start`・`/stop`・`/imakita`・`/notion_retry`・`/notion_default` Interaction、voice-gateway向けセッションAPI、Gateway ControlへのWebSocket接続を提供します。

各セッションは `guildId:channelId` で決まるDurable Objectに保存されます。セルフホストの voice-gateway が話者別 WAV chunk を認証付き HTTP で送信し、Worker は `@cf/openai/whisper-large-v3-turbo` で文字起こしします。GPU やローカル ASR サーバーは不要です。

音声は推論前に R2 へ保存し、成功した文字起こし結果はセッションの SQLite に保存します。成功後の音声は削除し、推論に失敗した音声は R2 に残します。同じ chunk を同じ区間番号で再送すると保存済み結果を返します。gateway は録音と並行して送信し、各リクエストで結果を受け取ります。Cloudflare Queues は使用しません。最終的な文字起こしと録音メタデータを含む manifest も R2 に保存します。Worker は manifest 用の短命な PUT 署名付き URL を発行し、gateway へ R2 API キーを渡しません。

## Discord設定

Discord Developer PortalのInteraction Endpoint URLを `https://<Workerのホスト>/interactions` に設定します。アプリケーションIDと公開鍵をWorker環境に設定し、`GATEWAY_CONTROL_TOKEN` にはvoice-gatewayと共有するランダムな値を設定します。

DiscordコマンドはWorkerのデプロイ後にGitHub Actionsからglobal commandとして登録されます。Workflowで使うため、GitHub Actions secretsに `DISCORD_BOT_TOKEN` を登録してください。アプリケーションIDは `wrangler.jsonc` とGitHub Actionsの設定で同じ値を使います。

ローカルから手動で登録する場合は、`DISCORD_APPLICATION_ID` と `DISCORD_BOT_TOKEN` を環境変数に設定して次を実行します。

```sh
pnpm --filter @ai-meeting-minutes/worker register:commands
```

Botには対象guildへの参加とVoice ChannelのView Channel・Connect権限が必要です。コマンドは対象VCのチャット内で入力します。最初に `/notion_default` のページ候補から、このVCの既定保存先を設定してください。以後 `/start` は引数なしで録音を開始し、既定ページの子ページに議事録を作成します。会議ごとに保存先を変える場合は `/start notion_page:` でNotionページ名を検索して選択します。`/notion_default` はサーバー管理権限が必要で、既定ページの確認・変更・解除ができます。`/imakita` はASRが確定した文字起こしをWorkers AIで要約します。WorkerはInteractionの `channel_id` を使って対象VCを決めます。

`/notion_retry` は直近の完了セッションでNotion保存が失敗した場合に、ページ更新を再試行します。

## Notionへの保存

Notion向けの議事録要約には、分割要約も含めて `@cf/google/gemma-4-26b-a4b-it` を使用します。`/imakita` は `@cf/qwen/qwen3-30b-a3b-fp8` を使用します。どちらも思考モードを無効にしています。

`/start` を実行すると既定または選択したNotionページの子ページ「AI議事録」を作成してDiscordにリンクを返します。セッション完了後、WorkerはR2のmanifestからWorkers AIで要約を作り、会議情報・要約・全文字起こしをそのページに反映します。開始時にNotionページを作成できなくても録音は続き、セッション完了後に新規作成を再試行します。DOはNotion出力の状態・試行回数・直近の失敗理由を保存し、最終出力に失敗した場合は初回を含め最大5試行します。AI要約に失敗した場合も全文字起こしを含むページを保存します。既定保存先が未設定の場合、`/start` は設定方法を案内して録音を開始しません。Notionへの保存が失敗した場合もセッションは完了扱いのままになり、manifestはR2に残ります。エラーはWorkerのログとセッション状態に記録されます。

1. Notion Developer Portalでinternal connectionを作成し、`Read content`、`Insert content`、`Update content` の権限を付けます。
2. 対象の議事録ページにconnectionを追加します。データベース内のページの場合は、そのデータベースにconnectionを追加します。
3. `/notion_default` で保存先に選ぶページをNotion connectionに共有します。この操作はDiscordのサーバー管理権限を持つ人が行います。

子ページの本文にはsession情報、要約、全文字起こしが入ります。

## ローカル開発

1. `pnpm exec wrangler r2 bucket create ai-meeting-minutes-recordings` でR2 bucketを作成します。
2. `.dev.vars.example` を `.dev.vars` にコピーし、Cloudflare account IDと、対象bucketへの書き込み権限を持つR2 API認証情報を設定します。
3. `GATEWAY_API_TOKEN` に十分長いランダム値を設定します。同じ値をvoice-gatewayの `WORKER_API_TOKEN` に設定します。
4. Workers AI bindingは `wrangler.jsonc` で設定済みです。ローカル開発でもCloudflare上のAI bindingを使います。
5. `pnpm --filter @ai-meeting-minutes/worker dev` でWorkerを起動します。

voice-gateway側は [`../../services/voice-gateway/.env.example`](../../services/voice-gateway/.env.example) を `.env` にコピーして設定できます。

`.dev.vars` はGit管理対象外です。実環境では `GATEWAY_API_TOKEN`、`GATEWAY_CONTROL_TOKEN`、`DISCORD_APPLICATION_PUBLIC_KEY`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`NOTION_API_TOKEN` をWrangler secretsとして登録してください。`DISCORD_APPLICATION_ID` はWorkerの環境変数として設定します。R2 bucket名は `wrangler.jsonc` の `R2_BUCKET_NAME` と `RECORDINGS` bindingで指定します。

gatewayとWorkerのHTTP契約は [`../../packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml) にあります。

## GitHub Actionsからのデプロイ

`main` へのpush後、CIが成功するとWorkerをCloudflareへデプロイします。GitHubリポジトリのActions secretsに `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を登録してください。API tokenは対象アカウントに限定し、Workers Scriptsの編集権限を付与します。

Workerの実行時secretやR2などのCloudflareリソースは、事前に本番環境へ設定してください。このworkflowはCloudflare Workerをデプロイします。voice-gateway はセルフホストし、[`../../services/voice-gateway/README.md`](../../services/voice-gateway/README.md) の Compose 手順で起動します。この workflow は gateway をデプロイしません。`services/asr` は実験用として残していますが、この構成では使用しません。
