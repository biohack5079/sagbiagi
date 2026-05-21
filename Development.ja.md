# SAGBI Linux インストーラーおよび Ollama + K8s セットアップ開発ガイド

## 概要
このドキュメントでは、**SAGBI インストーラー**の Linux 版の作成方法、および **Ollama** 推論エンジンと **Go シグナリングサーバー**を Kubernetes (K8s) クラスターにデプロイする手順について説明します。これらの手順は完全にスクリプト化されており、Docker/Kubernetes をサポートする任意の Linux ホスト（Ubuntu 22.04+、Debian、または Docker/Kubernetes をサポートする任意のディストリビューション）でプロセスを再現できます。

---
### 1️⃣ 前提条件
| ツール | 最小バージョン | インストールコマンド |
|------|----------------|-----------------|
| `docker` | 20.10+ | `sudo apt-get install -y docker.io` |
| `kubectl` | 1.27+ | `curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl` |
| `helm` | 3.12+ | `curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash` |
| `git` | 任意 | `sudo apt-get install -y git` |
| `curl` | 任意 | `sudo apt-get install -y curl` |
| `make` (任意) | 任意 | `sudo apt-get install -y build-essential` |

現在のユーザーが `docker` グループに追加されていることを確認してください：
```bash
sudo usermod -aG docker $USER
newgrp docker
```

---
### 2️⃣ Linux 版インストーラーの作成 (bash スクリプト)
軽量なインストーラーが **`installer/sagbi_installer_linux.sh`** として提供されています。これはターゲットマシンで以下の動作を行います。
1. **Ollama** (公式バイナリ) が存在しない場合、インストールします。
2. デフォルトモデル `gemma3:4b-it-q4_K_M` をプルします。
3. オプションの追加モデルをインストールします。
4. **SAGBI** Web UI (K8s 公開エンドポイント) を起動するためのデスクトップショートカットを作成します。

このスクリプトは意図的に**自己完結型**になっており、コンパイルされたバイナリを必要とせず、前述のツールのみで動作します。

#### 2.1 スクリプトの作成
```bash
#!/usr/bin/env bash
set -euo pipefail

# -------------------
# Constants
# -------------------
OLLAMA_URL="https://github.com/jmorganca/ollama/releases/download/v0.3.9/ollama-linux-amd64"
MODEL="gemma3:4b-it-q4_K_M"
INSTALL_DIR="${HOME}/.sagbi"

# -------------------
# Helper functions
# -------------------
log(){ echo -e "\e[32m[✔]\e[0m $*"; }
err(){ echo -e "\e[31m[✖]\e[0m $*" >&2; }

# -------------------
# 1. Install Ollama binary
# -------------------
if ! command -v ollama > /dev/null; then
    log "Ollama バイナリをダウンロード中..."
    curl -L "${OLLAMA_URL}" -o "${HOME}/ollama"
    chmod +x "${HOME}/ollama"
    sudo mv "${HOME}/ollama" /usr/local/bin/ollama
    log "Ollama が /usr/local/bin にインストールされました"
else
    log "Ollama は既にインストールされています"
fi

# -------------------
# 2. Start Ollama service (systemd)
# -------------------
if ! systemctl is-active --quiet ollama; then
    log "Ollama 用の systemd サービスを作成中..."
    sudo tee /etc/systemd/system/ollama.service > /dev/null <<'EOF'
[Unit]
Description=Ollama inference service
After=network.target

[Service]
ExecStart=/usr/local/bin/ollama serve
Restart=always
User=$USER
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now ollama
    log "Ollama サービスを起動しました"
else
    log "Ollama サービスは既に動作しています"
fi

# -------------------
# 3. Pull default model
# -------------------
log "デフォルトモデル ${MODEL} を取得中..."
ollama pull "${MODEL}"
log "モデル ${MODEL} の準備が完了しました"

# -------------------
# 3.5 RAG ディレクトリ設定
# -------------------
echo "-------------------------------------------------------"
echo "RAG ソースファイルが保存されているフォルダのフルパスを入力してください。"
echo "（空欄の場合、RAG 機能はデフォルトで無効になります）"
read -p "パス: " RAG_PATH

if [ -z "$RAG_PATH" ]; then
    log "RAG 設定をスキップしました。"
else
    echo "警告: これ以降、このフォルダが参照先となります。個人情報は入れないでください。"
    mkdir -p "signaling"
    echo "RAG_DIR=$RAG_PATH" > signaling/.env
    log "RAG ディレクトリを $RAG_PATH に設定し、signaling/.env に保存しました。"
fi

echo "-------------------------------------------------------"
echo "会話履歴（ログ）を保存するフォルダのフルパスを入力してください。"
echo "（GitHub 管理外のディレクトリを推奨します。空欄の場合、保存されません）"
read -p "履歴保存パス: " HIST_PATH

if [ -z "$HIST_PATH" ]; then
    log "履歴保存を無効にしました。"
else
    mkdir -p "$HIST_PATH"
    echo "HISTORY_DIR=$HIST_PATH" >> signaling/.env
    log "履歴保存パスを $HIST_PATH に設定しました。"
fi

# -------------------
# 5. Create launch shortcut
# -------------------
mkdir -p "${INSTALL_DIR}"
cat > "${HOME}/Desktop/SAGBI.desktop" <<EOF
[Desktop Entry]
Name=SAGBI AGI (Linux)
Comment=Local Ollama バックエンドを使用して SAGBI Web UI を起動
Exec=xdg-open http://localhost:8080
Icon=utilities-terminal
Terminal=false
Type=Application
Categories=Network;Utility;
EOF
chmod +x "${HOME}/Desktop/SAGBI.desktop"
log "デスクトップショートカットを ~/Desktop/SAGBI.desktop に作成しました"

log "インストールが完了しました！"
```

このスクリプトを **`installer/sagbi_installer_linux.sh`** として保存し、実行権限を付与します：
```bash
chmod +x installer/sagbi_installer_linux.sh
```

---
### 3️⃣ Kubernetes への Ollama & シグナリングサーバーのデプロイ
Kubernetes のマニフェストは `k8s/` 配下にあります。

#### 3.1 ネームスペース
```bash
kubectl apply -f k8s/namespace.yaml
```

#### 3.2 シグナリングサーバー (Go)
Goのソースをビルドしてレジストリにプッシュした後、デプロイメントを適用します。
```bash
cd signaling
docker build -t <your-registry>/sagbi-signaler:latest .
docker push <your-registry>/sagbi-signaler:latest
kubectl apply -f k8s/signal-deployment.yaml
```

---
### 4️⃣ ローカルでの開発と検証
Docker Compose を使って、ローカル環境ですぐにスタックを試すことができます。
```bash
docker compose up -d
```

ブラウザのコンソールから WebSocket の疎通確認を行う例:
```js
const ws = new WebSocket('ws://localhost:8080/ws/chat');
ws.onmessage = e => console.log('受信:', e.data);
```

---
### 5️⃣ テストの実行方法

#### 5.1 フロントエンド・ユニットテスト (Vitest)
メッセージ解析やジェスチャー（twirl, smile等）のトリガーロジックをテストします。
```bash
cd public/html
npm test
```

#### 5.2 バックエンド・ユニットテスト (Go)
RAGロジックやDB操作、ID生成をテストします。
```bash
cd signaling
go test -v .
```

#### 5.3 E2Eテスト (Playwright)
ブラウザを実際に動かし、会話からアニメーションまでの流れをテストします。
```bash
npx playwright test
```

---
## 🎉 開発準備完了
これで、Linux インストーラーの配布、K8s へのデプロイ、および各レイヤーのテストを行う準備が整いました。