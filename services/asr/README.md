# ASR Service

Qwen3-ASR-0.6Bを使い、voice-gatewayから受け取った音声を文字起こしするGPU側サービスです。voice-gatewayは会議全体を一度に送らず、30秒単位の音声を`/transcribe`へ送ります。

## Docker起動

NVIDIA GPUを使えるDocker環境で `.env.example` を `.env` にコピーし、`ASR_API_TOKEN` に十分長いランダム値を設定します。同じ値をvoice-gatewayの環境にも設定します。モデルの重みは初回起動時にダウンロードされ、名前付きvolumeにキャッシュされます。

```sh
cp .env.example .env
docker compose up -d --build
docker compose logs -f asr
```

`/health` が応答するまでモデルのダウンロードとロードに時間がかかる場合があります。`ASR_MODEL` と `ASR_GPU_MEMORY_UTILIZATION` は環境変数で変更できます。既定値はRTX 3060向けの0.6Bモデル、GPUメモリ使用率80%、文脈長32,768トークンです。

WindowsではDocker DesktopのWSL2 backendと、GPU対応NVIDIAドライバーが必要です。Docker DesktopがGPUを見つけるか確認するには、ホストで `docker run --rm --gpus=all nvcr.io/nvidia/k8s/cuda-sample:nbody nbody -gpu -benchmark` を実行します。

Gatewayからこのサービスへは、ASRホストのLANまたはVPNで到達できるIPアドレスやDNS名を使って `ASR_API_URL=http://<ASRホストのプライベートアドレス>:8000` を設定します。`ssh lingsha` のようなSSH設定上の別名は、GatewayやDockerコンテナから名前解決できるとは限りません。ASRポートは認証付きですがHTTP通信なので、インターネットへ直接公開せず、プライベートネットワークまたはVPN経由で接続してください。

## API

- `GET /health`: 起動確認。モデルロード完了後に `{"ready":true}` を返します。
- `POST /transcribe`: Bearer tokenで認証する音声ファイル文字起こしAPIです。voice-gatewayからは30秒ごとのWAVを受け取ります。
- `WS /stream`: 接続後、最初に `{"type":"start","token":"...","language":"Japanese","sample_rate":16000}` を送信します。16kHz mono float32 little-endianのバイナリ音声を受け取り、`ready`、`partial`、`final` JSONメッセージを返します。長時間会議には使わず、voice-gatewayと同じく短い独立区間で`/transcribe`を呼び出してください。

ASRサービスはDiscord Voiceへ接続せず、受信した音声ファイルも保存しません。接続と音声の区間化は `services/voice-gateway` が担当します。`/stream`は利用できますが、voice-gatewayの長時間会議経路では使いません。
