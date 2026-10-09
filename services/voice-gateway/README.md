# Voice Gateway

Discord Voice を受信するセルフホスト Node.js サービスです。音声認識は Cloudflare Workers AI の `@cf/openai/whisper-large-v3-turbo` を使用するため、GPU やローカル文字起こしサーバーは不要です。Discord の `/start`・`/stop`・`/imakita` は Worker が受け付け、gateway は外向き WebSocket で制御を受け取ります。

## 動作

- Discord のユーザー ID ごとに Opus 音声を受信・復号し、16kHz mono PCM16 の WAV を生成
- 話者別 buffer を1.5秒の無音で区切り、10秒以上なら送信。音声が60秒に達するか、発話開始から60秒経過したら短い発話も送信し、停止時は残りを送信
- WAV と区間情報をローカルに保存してから、録音と並行して Worker のセッション別 `/transcribe` に送信
- 区間番号・話者 ID・開始終了時刻を付け、失敗時は回数を制限して再試行
- Worker が返した確定結果をチェックポイントに保存し、会議終了時に manifest を R2 にアップロード

話者別の音声をミックスしないため、同時発話でも話者 ID を維持できます。区間番号はセッション全体で一意です。同じ chunk を同じ番号で再送すると Worker は保存済みの結果を返します。今回の構成では Cloudflare Queues を使わず、各 HTTP リクエストで推論結果を受け取ります。

## 起動

`.env.example` を参考に環境変数を設定してから、リポジトリルートで起動します。

```sh
pnpm --filter @ai-meeting-minutes/voice-gateway dev
```

- `DISCORD_BOT_TOKEN`: Discord Bot token
- `WORKER_API_URL`: Worker のベース URL。制御は同じホストの `/api/v1/gateway-control/connect` に WebSocket 接続します。
- `WORKER_API_TOKEN`: Worker の `GATEWAY_API_TOKEN` と同じ値
- `WORKER_CONTROL_TOKEN`: Worker の `GATEWAY_CONTROL_TOKEN` と同じ値
- `RECORDINGS_DIR`: WAV・manifest・チェックポイントの保存先。デフォルトは `services/voice-gateway/var/recordings`

Worker は音声を R2 に一時保存してから Workers AI に渡します。文字起こしが成功すると結果をセッションの SQLite に保存し、R2 の音声を削除します。推論に失敗した音声は R2 に残します。gateway も未確定の WAV をローカルに残し、成功した区間は削除します。再試行を使い切った場合はセッションを失敗として扱い、調査・再送用の一時データを残します。再起動による録音の自動再開や失敗セッションの自動復旧は行いません。

manifest の R2 PUT URL は Worker が発行するため、gateway に R2 API 認証情報は不要です。Bot には対象 Voice Channel の `ViewChannel` と `Connect` 権限が必要です。音声は送信しないため `Speak` 権限は不要です。

## 本番 Docker

GPU のない既存ホストでも動作します。Docker のネットワークから Discord Voice への外向き UDP 通信と応答の受信、および Worker への HTTPS/WebSocket 通信を許可してください。gateway の制御用ポートを外部公開する必要はありません。

`production.env.example` を `production.env` にコピーし、Discord Bot token、デプロイ済み Worker の URL、Worker と共有する2つの token を設定します。

```sh
cp production.env.example production.env
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs -f voice-gateway
```

Compose は既存の外部ネットワーク `server_default` に参加します。存在しない場合は `docker network create server_default` で作成してください。文字起こし用ネットワークは不要です。

録音データのディレクトリは named volume `recordings` に保存します。コンテナを作り直しても未確定の WAV とチェックポイントを保持します。停止は `docker compose -f compose.yaml down` を使用し、失敗時のデータが必要な間は `down -v` で volume を削除しないでください。
