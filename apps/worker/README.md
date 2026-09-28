# Worker

Cloudflare WorkerはDiscordの `/start`・`/stop` Interaction、voice-gateway向けセッションAPI、Gateway ControlへのWebSocket接続を提供します。

各セッションは `guildId:channelId` で決まるDurable Objectに保存されます。音声ファイルは保存せず、文字起こしと録音メタデータを含むmanifestのみR2へ保存します。Workerはmanifest用の短命なPUT署名付きURLを発行し、gatewayへR2 APIキーを渡しません。

## Discord設定

Discord Developer PortalのInteraction Endpoint URLを `https://<Workerのホスト>/interactions` に設定します。アプリケーションIDと公開鍵をWorker環境に設定し、`GATEWAY_CONTROL_TOKEN` にはvoice-gatewayと共有するランダムな値を設定します。

テスト用guildへコマンドを登録するには、`DISCORD_APPLICATION_ID`、`DISCORD_TEST_GUILD_ID`、`DISCORD_BOT_TOKEN` を環境変数に設定して次を実行します。

```sh
pnpm --filter @ai-meeting-minutes/worker register:commands
```

Botには対象guildへの参加とVoice ChannelのView Channel・Connect権限が必要です。コマンドは対象VCのチャット内で `/start` または `/stop` と入力します。WorkerはInteractionの `channel_id` を使って対象VCを決めます。

## Notionへの保存

セッションが完了すると、WorkerはR2のmanifestを読み、文字起こしと会議情報をNotionのdata sourceに1ページとして保存します。Notion設定がない環境では保存処理を行いません。Notionへの保存が失敗した場合もセッションは完了扱いのままになり、manifestはR2に残ります。エラーはWorkerのログに出力されます。

1. Notion Developer Portalでinternal connectionを作成し、`Insert content` と `Insert property` の権限を付けます。
2. 保存先のdatabaseにconnectionを追加します。
3. Notionのdatabase設定からdata source IDをコピーします。
4. ローカルでは `.dev.vars` に `NOTION_API_TOKEN` と `NOTION_DATA_SOURCE_ID` を設定します。本番では同じ名前でWorker secretsを登録します。

ページタイトルは録音開始時刻（JST）とsession IDから作成されます。本文にはsession情報と全文字起こしが入ります。要約は次の段階で追加します。

## ローカル開発

1. `pnpm exec wrangler r2 bucket create ai-meeting-minutes-recordings` でR2 bucketを作成します。
2. `.dev.vars.example` を `.dev.vars` にコピーし、Cloudflare account IDと、対象bucketへの書き込み権限を持つR2 API認証情報を設定します。
3. `GATEWAY_API_TOKEN` に十分長いランダム値を設定します。同じ値をvoice-gatewayの `WORKER_API_TOKEN` に設定します。
4. `pnpm --filter @ai-meeting-minutes/worker dev` でWorkerを起動します。

voice-gateway側は [`../../services/voice-gateway/.env.example`](../../services/voice-gateway/.env.example) を `.env` にコピーして設定できます。

`.dev.vars` はGit管理対象外です。実環境では `GATEWAY_API_TOKEN`、`GATEWAY_CONTROL_TOKEN`、`DISCORD_APPLICATION_PUBLIC_KEY`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`NOTION_API_TOKEN`、`NOTION_DATA_SOURCE_ID` をWrangler secretsとして登録してください。`DISCORD_APPLICATION_ID` はWorkerの環境変数として設定します。R2 bucket名は `wrangler.jsonc` の `R2_BUCKET_NAME` と `RECORDINGS` bindingで指定します。

gatewayとWorkerのHTTP契約は [`../../packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml) にあります。
