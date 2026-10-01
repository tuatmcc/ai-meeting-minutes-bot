# AI Meeting Minutes Bot

Discord 上の会議音声を認識し、Workers AI を活用した議事録の作成と Notion への保存を目指すプロジェクトです。Cloudflare Workers 上のアプリケーションと、GPU 環境で動作する音声認識サービスを組み合わせる構成です。

## 構成

- `apps/worker`: VC単位のセッション管理APIを提供するCloudflare Workerです。セッション状態はDurable Objects、録音メタデータはR2に保存します。
- `services/voice-gateway`: Discord Voice への接続と録音を担うNode.jsサービスです。WAVはR2に送らず、manifestのみアップロードします。
- `services/asr`: Qwen3-ASR-0.6B/vLLMによる音声認識を担うGPU側サービスです。Windows + Docker DesktopのWSL2 GPU環境向けComposeを含みます。

Workerとvoice-gateway間のHTTP契約は [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml) を参照してください。Discordの `/start`・`/stop` コマンドから録音を操作し、`/imakita` で進行中の会議を要約できます。`/start` で指定されたNotionページの子ページを作成し、録音終了後にAI要約と全文字起こしを反映します。保存失敗は `/notion_retry` で再試行できます。

## WindowsのDocker DesktopでGatewayとASRを起動

GatewayコンテナとGPUを使うASRコンテナを、同じWindows PC上のDocker Desktopで別々に起動する手順です。Cloudflare Workerはデプロイ済みで、Discord BotとNotionの設定も完了していることを前提にします。

### 事前準備

- Docker DesktopをWSL2 backendで起動します。
- NVIDIA GPUを使う場合は、GPU対応のWindows用NVIDIAドライバーをインストールします。DockerからGPUが見えるかPowerShellで確認します。

  ```powershell
  docker run --rm --gpus=all nvcr.io/nvidia/k8s/cuda-sample:nbody nbody -gpu -benchmark
  ```

- このリポジトリをWindowsからアクセスできる場所にcloneし、PowerShellでリポジトリのルートへ移動します。
- ASRモデルは初回起動時にダウンロードされます。モデルのダウンロードとロードには時間がかかることがあります。

### ASRの設定と起動

```powershell
Copy-Item services/asr/.env.example services/asr/.env
notepad services/asr/.env
```

`services/asr/.env` の `ASR_API_TOKEN` に十分長いランダムな値を設定します。この値は後でGateway側にも同じものを設定します。`.env` は秘密情報を含むため、Gitにコミットしないでください。

ASRコンテナを起動します。

```powershell
Set-Location services/asr
docker compose up -d --build
docker compose logs -f asr
```

モデルのロードが完了したら、別のPowerShellで次のコマンドが `{"ready":true}` を返すことを確認します。

```powershell
docker compose -f services/asr/compose.yaml exec asr python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"
```

### Gatewayの設定と起動

リポジトリのルートに戻って環境ファイルを作成します。

```powershell
Set-Location ../..
Copy-Item services/voice-gateway/production.env.example services/voice-gateway/production.env
notepad services/voice-gateway/production.env
```

`services/voice-gateway/production.env` を次のように設定します。

- `DISCORD_BOT_TOKEN`: Discord Bot token
- `WORKER_API_URL`: デプロイ済みCloudflare WorkerのURL（`https://...`）
- `WORKER_API_TOKEN`: Workerの `GATEWAY_API_TOKEN` と同じ値
- `WORKER_CONTROL_TOKEN`: Workerの `GATEWAY_CONTROL_TOKEN` と同じ値
- `ASR_API_URL`: `http://host.docker.internal:8000`。コンテナからWindowsホストで公開されたASRポートへ接続します。
- `ASR_API_TOKEN`: ASR側の `.env` に設定した値と同じ値

GatewayのComposeは外部ネットワーク `server_default` と `asr_default` を参照するため、まだ作成されていない場合は一度だけ作成します。

```powershell
docker network create server_default
docker network create asr_default
```

すでに存在するネットワークについて `already exists` と表示された場合は、そのまま次へ進みます。続けてGatewayを起動します。

```powershell
Set-Location services/voice-gateway
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs -f voice-gateway
```

ログに `[gateway-control] connected` が出ればWorkerとの接続ができています。ASR APIは認証付きHTTPです。Windows Defender Firewallで8000番ポートを許可する場合は、必要なプライベートネットワークに限定し、インターネットへ公開しないでください。

### 停止と再起動

各ディレクトリで `docker compose down` を実行すると、そのサービスを停止できます。例として、Gatewayは `services/voice-gateway` で `docker compose -f compose.yaml down`、ASRは `services/asr` で `docker compose down` を実行します。モデルキャッシュを保持するには `docker compose down -v` は実行しないでください。
