# Voice Gateway

Discord Voiceから音声を受信し、録音しながらQwen3-ASRへリアルタイムに送るサービスです。

## 現在の動作

- DAVE対応のDiscord Voice接続
- 受信Opus音声のPCMデコード
- 複数ユーザーの48kHz stereo PCMミックス
- 録音中のASR WebSocketストリーミング
- 指定秒数（デフォルト30秒）の一時WAV保存
- `manifest.json`への録音メタデータ保存

現在は検証用に、起動すると指定されたVoice Channelへ接続し、録音中の音声を `ASR_API_URL` の `/stream` WebSocketへ送ります。48kHz stereo PCM16を16kHz mono float32へ変換し、2秒ごとに送信します。ASRのpartial結果はgatewayのコールバックで受け取り、final結果と録音メタデータをmanifestへ保存します。Cloudflare WorkerのVC単位Durable Objectはセッション状態を管理します。R2にはmanifestのみアップロードし、一時WAVは成功後に削除します。ASRやアップロードに失敗した場合は調査用に残します。録音のpause/resumeは次の段階で追加します。

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
