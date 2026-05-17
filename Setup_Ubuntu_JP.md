# SAGBI AGI セットアップガイド (Ubuntu 26.04対応)

このドキュメントでは、Ubuntu 26.04 環境で **SAGBI AGI** (シグナリングサーバー + Ollama 推論エンジン) をセットアップして実行する手順を説明します。

---

## 1. 事前準備

以下のツールをインストールしてください。

| ツール | 用途 | インストールコマンド |
|------|------|-----------------|
| `docker.io` | コンテナ実行 | `sudo apt-get update && sudo apt-get install -y docker.io` |
| `docker-compose` | 複数コンテナ管理 | `sudo apt-get install -y docker-compose-v2` |
| `golang` | シグナリングサーバーのビルド | `sudo apt-get install -y golang` |
| `curl` | Ollama のダウンロード | `sudo apt-get install -y curl` |

### Docker 権限の設定
現在のユーザーで Docker を実行できるようにします。
```bash
sudo usermod -aG docker $USER
# 一度ログアウトして再ログインするか、以下のコマンドを実行
newgrp docker
```

---

## 2. Ollama のセットアップ (ホスト実行の場合)

Docker を使わずに直接 Ollama を実行する場合の手順です。

1. **インストール**:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

2. **モデルのダウンロード**:
   SAGBI AGI のデフォルトモデルをプルします。
   ```bash
   ollama pull gemma3:4b-it-q4_K_M
   ```

---

## 3. アプリケーションの起動

### 方法 A: Docker Compose を使用する (推奨)

プロジェクトのルートディレクトリに `docker-compose.yml` を作成し、一括起動します。

```yaml
version: "3.9"
services:
  ollama:
    image: ghcr.io/jmorganca/ollama:0.3.9
    ports:
      - "11434:11434"
    restart: unless-stopped
  signaler:
    build: ./signaling
    volumes:
      - ./public/html:/app/static
    environment:
      - OLLAMA_URL=http://ollama:11434
    ports:
      - "8080:8080"
    depends_on:
      - ollama
```

起動コマンド:
```bash
docker compose up -d
```

### 方法 B: ローカルで直接実行する

1. **シグナリングサーバーの起動**:
   ```bash
   cd signaling
   # 静的ファイルのリンクを作成 (初回のみ)
   ln -s ../public/html static
   # 実行
   go run main.go
   ```

2. **ブラウザでアクセス**:
   [http://localhost:8080](http://localhost:8080) を開きます。

---

## 4. 本番デプロイ時の注意点

- **WebSocket URL**: `public/html/chat.js` 内の `SIGNALING_URL` を、実際のサーバーのドメイン（例: `wss://your-domain.com/ws/chat`）に書き換えてください。
- **リソース制限**: Gemma 3 (4B) モデルは最低でも 4GB 以上の RAM を推奨します。CPU のみの環境では回答に時間がかかる場合があります。
- **セキュリティ**: 本番環境では Ingress や Nginx リバースプロキシを介して、SSL/TLS (HTTPS/WSS) を有効にすることを強く推奨します。
