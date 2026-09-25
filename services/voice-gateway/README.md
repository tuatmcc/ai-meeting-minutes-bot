# Voice Gateway

Discord Voiceから音声を受信し、録音ファイルとして保存するサービスです。
Qwen3-ASRによる文字起こしは `services/asr` が担当します。

## 現在の動作

- DAVE対応のDiscord Voice接続
- 受信Opus音声のPCMデコード
- 複数ユーザーの48kHz stereo PCMミックス
- 指定秒数（デフォルト30秒）のWAV保存
- `manifest.json`への録音メタデータ保存

現在は検証用に、起動すると指定されたVoice Channelへ接続して録音し、
録音終了後にプロセスを終了します。セッション状態はCloudflare WorkerのVC単位Durable Objectで管理します。録音WAVを `ASR_API_URL` の `/transcribe` に送り、文字起こしを含むmanifestのみR2へアップロードします。成功後はローカル録音を削除し、ASRやアップロードに失敗した場合は調査用に残します。録音のセグメント化とpause/resumeは次の段階で追加します。

## 起動

```sh
export DISCORD_BOT_TOKEN='...'
export DISCORD_GUILD_ID='...'
export DISCORD_VOICE_CHANNEL_ID='...'
export WORKER_API_URL='http://localhost:8787'
export WORKER_API_TOKEN='same-value-as-GATEWAY_API_TOKEN'
export ASR_API_URL='http://lingsha:8000'

pnpm --filter @ai-meeting-minutes/voice-gateway dev
```

`WORKER_API_URL` はWorkerのURL、`WORKER_API_TOKEN` はWorker側の `GATEWAY_API_TOKEN` と同じ値です。`ASR_API_URL` はASRサーバーのベースURLです。manifest用のR2 PUT URLはWorkerが発行するため、gatewayにR2 API認証情報を設定する必要はありません。

任意の環境変数:

- `RECORD_SECONDS`: 録音秒数。デフォルトは `30`
- `RECORDINGS_DIR`: 保存先。デフォルトはこのサービス配下の `var/recordings`

`DISCORD_GUILD_ID`と`DISCORD_VOICE_CHANNEL_ID`には数値IDを指定できます。
`DISCORD_VOICE_CHANNEL_ID`はDiscordのチャンネルURLでも指定できます。

出力例:

```text
services/voice-gateway/var/recordings/2026-09-25T12-00-00-000Z/
├── manifest.json
└── mixed-48khz-stereo.wav
```

ASR成功後にWAVとローカルmanifestは削除されます。失敗した場合は録音フォルダに残ります。

Voice受信には、Botが対象Guildに所属し、対象Voice Channelへの接続権限を持っている必要があります。
