# AI Meeting Minutes Bot

Discord 上の会議音声を文字起こしし、Workers AI で議事録を作成して Notion に保存するプロジェクトです。Discord Voice を受信する gateway だけをセルフホストし、音声認識・セッション管理・議事録生成は Cloudflare に載せます。GPU やローカル ASR サーバーは不要です。

## 構成

- `services/voice-gateway`: CPU で動作する Node.js サービスです。Discord Voice の音声を話者ごとに受信・復号し、16kHz mono PCM16 の WAV chunk を Worker に送信します。
- `apps/worker`: Discord コマンド、Durable Objects によるセッション管理、Workers AI Whisper による文字起こし、AI 議事録生成と Notion 保存を提供します。
- `services/asr`: Qwen3-ASR/vLLM の実験用サービスを残しています。通常の構成では使用しません。

```text
セルフホスト Voice gateway
  Discord 音声受信 → 話者別 WAV chunk
                           ↓
Cloudflare Worker → R2 に一時保存 → Workers AI Whisper
                                           ↓
                              Durable Object に文字起こし保存
                                           ↓
                              Workers AI 議事録生成 → Notion
```

話者別 buffer は無音区間で区切り、10〜60秒程度で送信します。短い発話も開始から60秒経過した時点か、録音停止時に送信します。Worker への送信は録音と並行して行い、各リクエストで文字起こし結果を受け取ります。Cloudflare Queues は使用しません。

Worker と gateway 間の HTTP 契約は [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml) を参照してください。Discord の `/start`・`/stop` で録音を操作し、`/imakita` で確定済みの文字起こしを要約します。`/start` は引数なしで実行でき、VCごとの既定ページに議事録と全文字起こしを保存します。会議ごとに保存先を変える場合はページ名から候補を選べます。保存失敗は `/notion_retry` で再試行できます。

## セルフホスト Gateway の起動

Docker と Docker Compose が使える常時稼働ホストを用意します。Discord Voice に対する外向き UDP 通信と、その応答を受信できるネットワークが必要です。Worker のデプロイと Discord Bot・Notion の設定は [`apps/worker/README.md`](apps/worker/README.md) を参照してください。

リポジトリのルートで環境ファイルを作成します。

```sh
cp services/voice-gateway/production.env.example services/voice-gateway/production.env
```

`production.env` に次を設定します。秘密情報を含むため Git にコミットしないでください。

- `DISCORD_BOT_TOKEN`: Discord Bot token
- `WORKER_API_URL`: デプロイ済み Worker の URL
- `WORKER_API_TOKEN`: Worker の `GATEWAY_API_TOKEN` と同じ値
- `WORKER_CONTROL_TOKEN`: Worker の `GATEWAY_CONTROL_TOKEN` と同じ値

Compose は既存の外部ネットワーク `server_default` に参加します。ホストに存在しない場合は一度作成します。

```sh
docker network create server_default
docker compose -f services/voice-gateway/compose.yaml up -d --build
docker compose -f services/voice-gateway/compose.yaml logs -f voice-gateway
```

ログに `[gateway-control] connected` が出れば Worker との制御接続ができています。ASR コンテナや GPU の設定は不要です。

未送信・未確定の WAV とチェックポイントは Docker volume に保存されます。成功後に一時データを削除し、失敗時は調査・再送用に残します。Worker も推論前に音声を R2 に保存し、成功後に削除します。コンテナの再起動だけで録音や失敗セッションを自動復旧する構成ではありません。

停止は次のコマンドで行います。失敗時のデータを保持するため `down -v` は実行しないでください。

```sh
docker compose -f services/voice-gateway/compose.yaml down
```
