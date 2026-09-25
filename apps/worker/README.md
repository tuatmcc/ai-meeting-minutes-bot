# Worker

Cloudflare Workerがvoice-gateway向けのセッションAPIを提供します。Discord Interactionとスラッシュコマンドはまだ受け付けません。

各セッションは `guildId:channelId` で決まるDurable Objectに保存されます。R2に保存するのはmanifestのみで、WAVはR2へアップロードしません。Workerはmanifest用の短命なPUT署名付きURLを発行し、gatewayへR2 APIキーを渡しません。

## ローカル開発

1. `pnpm exec wrangler r2 bucket create ai-meeting-minutes-recordings` でR2 bucketを作成します。
2. `.dev.vars.example` を `.dev.vars` にコピーし、Cloudflare account IDと、対象bucketへの書き込み権限を持つR2 API認証情報を設定します。
3. `GATEWAY_API_TOKEN` に十分長いランダム値を設定します。同じ値をvoice-gatewayの `WORKER_API_TOKEN` に設定します。
4. `pnpm --filter @ai-meeting-minutes/worker dev` でWorkerを起動します。

voice-gateway側は [`../../services/voice-gateway/.env.example`](../../services/voice-gateway/.env.example) を `.env` にコピーして設定できます。

`.dev.vars` はGit管理対象外です。実環境では `GATEWAY_API_TOKEN`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` をWrangler secretsとして登録してください。R2 bucket名は `wrangler.jsonc` の `R2_BUCKET_NAME` で指定します。

gatewayとWorkerのHTTP契約は [`../../packages/contracts/openapi.yaml`](../../packages/contracts/openapi.yaml) にあります。
