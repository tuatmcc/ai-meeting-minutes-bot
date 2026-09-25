# AI Meeting Minutes Bot

Discord 上の会議音声を認識し、Workers AI を活用した議事録の作成と Notion への保存を目指すプロジェクトです。Cloudflare Workers 上のアプリケーションと、GPU 環境で動作する音声認識サービスを組み合わせる構成です。

## 構成

- `apps/worker`: VC単位のセッション管理APIを提供するCloudflare Workerです。セッション状態はDurable Objects、録音メタデータはR2に保存します。
- `services/voice-gateway`: Discord Voice への接続と録音を担うNode.jsサービスです。WAVはR2に送らず、manifestのみアップロードします。
- `services/asr`: 録音済み音声に対するQwen3-ASRの推論を担うGPU側サービスです。

Workerとvoice-gateway間のHTTP契約は [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml) を参照してください。Discordのスラッシュコマンドはまだ実装していません。
