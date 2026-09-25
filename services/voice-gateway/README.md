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
録音終了後にプロセスを終了します。録音のセグメント化とpause/resumeは次の段階で追加します。

## 起動

```sh
export DISCORD_BOT_TOKEN='...'
export DISCORD_GUILD_ID='...'
export DISCORD_VOICE_CHANNEL_ID='...'

pnpm --filter @ai-meeting-minutes/voice-gateway dev
```

任意の環境変数:

- `RECORD_SECONDS`: 録音秒数。デフォルトは `30`
- `RECORDINGS_DIR`: 保存先。デフォルトはリポジトリ直下の `var/recordings`

`DISCORD_GUILD_ID`と`DISCORD_VOICE_CHANNEL_ID`には数値IDを指定できます。
`DISCORD_VOICE_CHANNEL_ID`はDiscordのチャンネルURLでも指定できます。

出力例:

```text
var/recordings/2026-09-25T12-00-00-000Z/
├── manifest.json
└── mixed-48khz-stereo.wav
```

Voice受信には、Botが対象Guildに所属し、対象Voice Channelへの接続権限を持っている必要があります。
