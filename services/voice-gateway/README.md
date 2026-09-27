# Voice Gateway

Discord Voiceから音声を受信し、30秒単位でQwen3-ASRへ送り文字起こしするサービスです。Discordの`/start`・`/stop`コマンドはWorkerが受け付け、gatewayはWorkerへ外向きWebSocketで接続して制御を受け取ります。

## 動作

- Discord Voiceへ接続し、受信Opus音声をPCMにデコードして複数ユーザーの48kHz stereo音声をミックス
- 16kHz mono音声を30秒ごとに切り出し、2秒の重複を含めてASR `/transcribe` へ送信
- ASRの確定結果を区間ごとに一時チェックポイントへ保存し、会議終了時に結合
- VCのチャットで実行した`/start`・`/stop`から、そのVCのセッションを開始・終了
- VC単位Durable Objectの状態を更新し、ASR結果を含むmanifestだけをR2へアップロード
- manifestだけを一時保存し、正常終了後に削除

受信Opus音声を48kHz stereo PCM16へデコード・ミックスし、16kHz mono float32へ変換します。ASRは各30秒区間を独立して認識するため、モデルが会議全体の音声を蓄積しません。隣接区間は2秒重ね、認識文字列の一致部分を除いて結合します。区間ごとの結果と開始・終了時刻、結合済み文字起こしはmanifestに保存します。

## 起動

`.env.example`を参考に環境変数を設定し、ASRサービスと同じ`ASR_API_TOKEN`を設定してからリポジトリルートから起動します。

```sh
pnpm --filter @ai-meeting-minutes/voice-gateway dev
```

- `DISCORD_BOT_TOKEN`: Discord Bot token
- `WORKER_API_URL`: WorkerのベースURL。gatewayは同じホストの`/api/v1/gateway-control/connect`へWebSocket接続します。
- `WORKER_API_TOKEN`: Workerの`GATEWAY_API_TOKEN`と同じ値。セッションAPIの認証に使います。
- `WORKER_CONTROL_TOKEN`: Workerの`GATEWAY_CONTROL_TOKEN`と同じ値。制御WebSocketの認証に使います。
- `ASR_API_URL`: ASRサーバーのベースURL
- `ASR_API_TOKEN`: ASRサービスと共有する十分長いランダムな認証トークン
- `RECORDINGS_DIR`: manifestの一時保存先。デフォルトは`services/voice-gateway/var/recordings`

音声はローカルファイルに保存しません。ミックスした音声を30秒区間にしてASRへ送り、未処理待ち行列は最大2区間に制限します。確定した区間テキストは一時チェックポイントへ追記します。終了後、文字起こしと録音メタデータを含むmanifestだけをR2へアップロードします。manifest用のR2 PUT URLはWorkerが発行するため、gatewayにR2 API認証情報を設定する必要はありません。gatewayはDiscord Botの`ViewChannel`と`Connect`権限を必要とします。Botは音声を送信しないため`Speak`権限は不要です。

manifestは次のようにsession IDごとに一時保存され、成功後にディレクトリごと削除されます。失敗時は調査用に残ります。

```text
services/voice-gateway/var/recordings/<session-id>/
├── manifest.json
└── transcription-segments.jsonl
```

`transcription-segments.jsonl`にはASRが確定した区間ごとの結果が追記されます（区間処理が始まると作成）。正常終了後はmanifestのアップロードとともに一時ディレクトリを削除します。ASRの処理が音声入力に追いつかず、待ち行列が上限を超えた場合はセッションを失敗として扱います。

## 本番Docker

`production.env.example`を`production.env`にコピーし、Discord Bot token、デプロイ済みWorkerのURL、Workerと共有する2つのtokenを設定します。R2の認証情報はWorker側だけに設定し、Gatewayには渡しません。

このCompose定義は外部Dockerネットワーク`server_default`に参加します。ASRサービスを別ホストで起動する場合は、`ASR_API_URL`にそのホストのプライベートネットワーク上のアドレスを設定します。ASR側の`ASR_API_TOKEN`と同じ値を使い、ASRホストの8000番ポートへはプライベートネットワークまたはVPNから接続できるようにします。

```sh
cp production.env.example production.env
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs -f voice-gateway
```
