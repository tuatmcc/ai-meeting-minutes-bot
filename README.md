# AI Meeting Minutes Bot

Discord 上の会議音声を認識し、議事録の作成を支援することを目指すプロジェクトです。Cloudflare Workers 上のアプリケーションと、GPU 環境で動作する音声認識サービスを組み合わせる構成です。

## 構成

- `apps/worker`: Cloudflare Workers 上で動作するアプリケーションです。
- `services/asr`: Discord の音声取得と音声認識を担う GPU 側サービスです。

現在は開発初期段階で、各サービスの実装は雛形です。
