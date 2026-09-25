# Voice Gateway

Discord Voiceから音声を受信し、録音中の音声をQwen3-ASRへリアルタイムに送るサービスです。Discordの`/start`・`/stop`コマンドはWorkerが受け付け、gatewayはWorkerへ外向きWebSocketで接続して制御を受け取ります。

## 動作

- Discord Voiceへ接続し、受信Opus音声をPCMにデコードして複数ユーザーの48kHz stereo音声をミックス
- 録音中に音声をASR `/stream` WebSocketへストリーミング
- VCのチャットで実行した`/start`・`/stop`から、そのVCのセッションを開始・終了
- VC単位Durable Objectの状態を更新し、ASR結果を含むmanifestだけをR2へアップロード
- manifestだけを一時保存し、正常終了後に削除

ASRには48kHz stereo PCM16を16kHz mono float32へ変換して2秒ごとに送ります。partial結果は現在gatewayのログに出し、final結果と録音メタデータはmanifestに保存します。

## 起動

`.env.example`を参考に環境変数を設定し、リポジトリルートから起動します。

```sh
pnpm --filter @ai-meeting-minutes/voice-gateway dev
```

- `DISCORD_BOT_TOKEN`: Discord Bot token
- `WORKER_API_URL`: WorkerのベースURL。gatewayは同じホストの`/api/v1/gateway-control/connect`へWebSocket接続します。
- `WORKER_API_TOKEN`: Workerの`GATEWAY_API_TOKEN`と同じ値。セッションAPIの認証に使います。
- `WORKER_CONTROL_TOKEN`: Workerの`GATEWAY_CONTROL_TOKEN`と同じ値。制御WebSocketの認証に使います。
- `ASR_API_URL`: ASRサーバーのベースURL
- `RECORDINGS_DIR`: manifestの一時保存先。デフォルトは`services/voice-gateway/var/recordings`

音声はローカルファイルに保存しません。ミックスした48kHz PCMをそのままASRへ送り、終了後に文字起こしと録音メタデータを含むmanifestだけをR2へアップロードします。manifest用のR2 PUT URLはWorkerが発行するため、gatewayにR2 API認証情報を設定する必要はありません。gatewayはDiscord Botの`ViewChannel`と`Connect`権限を必要とします。Botは音声を送信しないため`Speak`権限は不要です。

manifestは次のようにsession IDごとに一時保存され、成功後にディレクトリごと削除されます。失敗時は調査用に残ります。

```text
services/voice-gateway/var/recordings/<session-id>/
├── manifest.json
```

## 本番Docker

`production.env.example`を`production.env`にコピーし、Discord Bot token、デプロイ済みWorkerのURL、Workerと共有する2つのtokenを設定します。R2の認証情報はWorker側だけに設定し、Gatewayには渡しません。

このCompose定義は、ASRコンテナが接続している外部Dockerネットワーク`server_default`に参加します。ASRはそのネットワーク上の`server:8000`で参照します。Gatewayの待受ポート公開は不要です。

```sh
cp production.env.example production.env
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs -f voice-gateway
```
