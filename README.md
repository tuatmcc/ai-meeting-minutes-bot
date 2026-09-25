# AI Meeting Minutes Bot

Discord 上の会議音声を認識し、Workers AI を活用した議事録の作成と Notion への保存を目指すプロジェクトです。Cloudflare Workers 上のアプリケーションと、GPU 環境で動作する音声認識サービスを組み合わせる構成です。

## 構成

- `apps/worker`: Cloudflare Workers 上で動作し、Workers AI との連携を担うアプリケーションです。
- `services/asr`: Discord の音声取得と音声認識を担う GPU 側サービスです。
