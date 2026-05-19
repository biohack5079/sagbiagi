#!/bin/bash

# SAGBI AGI Automatic Launcher
# This script starts the signaling server, creates a tunnel, and opens the production HP.

echo "--- SAGBI AGI Launcher ---"

# 0. Check for Ollama
if ! command -v ollama &> /dev/null; then
    echo "[Error] Ollama is not installed."
    echo "Please run: curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

# Check if the model exists, if not, try to pull it
MODEL="gemma3:4b-it-q4_K_M"
if ! ollama list | grep -q "$MODEL"; then
    echo "Model $MODEL not found. Pulling now (this may take a while)..."
    ollama pull "$MODEL"
fi

# Check if Ollama service is actually responding
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "Ollama service is not running. Starting it in background..."
    ollama serve > /dev/null 2>&1 &
    sleep 10 # 起動時間を長めに確保
fi


# 1. Start Signaling Server in background
echo "[1/3] Starting Signaling Server (Go)..."

# 環境変数を読み込んでポートを確認
if [ -f signaling/.env ]; then
    export $(grep -v '^#' signaling/.env | xargs)
fi
PORT_CFG=${LISTEN_ADDR:-:8080}
CHECK_PORT=${PORT_CFG#*:}

# 以前のSAGBI関連プロセスを確実に終了させる
echo "Cleaning up old SAGBI processes..."
pkill -f sagbi-server || true
pkill -f cloudflared || true
pkill -f terminal_receiver.js || true
if command -v fuser >/dev/null; then
    fuser -k $CHECK_PORT/tcp >/dev/null 2>&1 || true
fi
sleep 1

cd signaling
# go run ではなく build 済みのバイナリを使うことで2回目以降を爆速にする
if [ ! -f sagbi-server ] || [ main.go -nt sagbi-server ]; then
    echo "Compiling signaling server..."
    go build -o sagbi-server main.go
fi
./sagbi-server > ../signaling.log 2>&1 &
SIGNAL_PID=$!

# サーバーが立ち上がるまで待機 (タイムアウト付き)
echo "Waiting for signaling server to listen on :$CHECK_PORT..."
RETRIES=0
while ! curl -s http://localhost:$CHECK_PORT/healthz > /dev/null; do
    sleep 1
    echo -n "."
    RETRIES=$((RETRIES+1))
    if [ $RETRIES -gt 30 ]; then
        echo -e "\n[Error] Signaling server failed to start. Check signaling.log"
        echo "--- Last 10 lines of signaling.log ---"
        tail -n 10 ../signaling.log
        kill $SIGNAL_PID 2>/dev/null || true
        exit 1
    fi
done
cd ..

# --- Kubernetes Port-Forward (Optional: If using K8s) ---
# 'kubectl' があり、かつ 'sagbi' 名前空間にアクセス可能な場合のみ K8s モードを試行する
if command -v kubectl > /dev/null && kubectl get ns sagbi > /dev/null 2>&1; then
    # サービスの存在を確認してからポートフォワードを実行
    if kubectl get svc sagbi-service -n sagbi > /dev/null 2>&1; then
        echo "Ensuring K8s Port-forward to Signaler..."
        kubectl port-forward -n sagbi svc/sagbi-service 8080:80 > /dev/null 2>&1 &
        sleep 2
    fi

    # Deployment の存在を確認してからモデルのチェック/プルを実行
    if kubectl get deployment ollama -n sagbi > /dev/null 2>&1; then
        echo "Checking for model $MODEL in Kubernetes Ollama deployment..."
        if ! kubectl exec -n sagbi deployment/ollama -- ollama list 2>/dev/null | grep -q "$MODEL"; then
            echo "Model $MODEL not found in K8s. Pulling now (this may take a while)..."
            kubectl exec -n sagbi deployment/ollama -- ollama pull "$MODEL"
        else
            echo "Model $MODEL is already present in Kubernetes."
        fi
    fi
else
    echo "[Info] Kubernetes 'sagbi' namespace not found or cluster unreachable. Running in Local Mode."
fi
# -------------------------------------------------------

# 2. Start Cloudflare Tunnel and catch the URL
echo "[2/3] Creating Cloudflare Tunnel..."
# We use a temporary log file to catch the assigned URL
TUNNEL_LOG="tunnel.log"
rm -f $TUNNEL_LOG
cloudflared tunnel --url http://localhost:8080 > $TUNNEL_LOG 2>&1 &
TUNNEL_PID=$!

echo "Waiting for tunnel URL..."
CLOUDFLARE_URL=""
MAX_RETRIES=20
COUNT=0

while [ -z "$CLOUDFLARE_URL" ] && [ $COUNT -lt $MAX_RETRIES ]; do
    sleep 2
    CLOUDFLARE_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" $TUNNEL_LOG | head -n 1)
    COUNT=$((COUNT+1))
    echo -n "."
done

if [ -z "$CLOUDFLARE_URL" ]; then
    echo -e "\nError: Could not obtain Cloudflare Tunnel URL. Check tunnel.log"
    kill $SIGNAL_PID $TUNNEL_PID
    exit 1
fi

echo "[3/3] Updating Cloudflare Worker Environment..."

# 🚨 【修正ポイント】
# `--secret-text` フラグを廃止し、echo の出力をパイプで流し込んでシークレットを登録します。
if echo "$CLOUDFLARE_URL" | wrangler secret put TUNNEL_URL --name sagbi; then
    echo "Worker environment variable updated successfully!"
    echo "Waiting for Cloudflare propagation (5s)..."
    sleep 5

    # 疎通確認: Worker経由でGoサーバーのヘルスチェックを叩く
    CHECK_URL="https://sagbi.biohack5079.workers.dev/healthz?t=$(date +%s)"
    if curl -s --max-time 5 "$CHECK_URL" | grep -qi "ok"; then
        echo "✅ Online: Your Local AI is now accessible from the Web via Cloudflare."
    else
        echo "⚠️  Worker update finished, but end-to-end Health Check failed at $CHECK_URL"
        echo "   Check signaling.log and your Cloudflare Worker logs."
    fi
else
    echo "❌ Failed to update Cloudflare Worker."
fi

echo "(Skipped firebase deploy. Firebase is safe!)"

echo -e "\nTunnel Ready: $CLOUDFLARE_URL"

# 3. Open Browser
PRODUCTION_URL="https://sagbiagi.web.app/"
FINAL_URL=$PRODUCTION_URL

# Local Preview check
if curl -s --max-time 1 http://localhost:4173 > /dev/null; then
    echo "[Info] Local frontend dev server (Vite) detected."
    FINAL_URL="http://localhost:4173/"
else
    echo "Using Production Web URL: $PRODUCTION_URL"
fi

echo "Target URL: $FINAL_URL"
echo "Please open the URL above manually to access SAGBI."

# 4. Start Terminal Receiver
if command -v node > /dev/null && [ -f terminal_receiver.js ]; then
    echo "[4/3] Starting Terminal Chat Receiver..."
    if [ ! -d "node_modules/ws" ] || [ ! -f "node_modules/wrtc/package.json" ]; then
        echo "Checking dependencies for terminal receiver..."
        # wsを優先。wrtcは失敗してもスクリプトを止めないように || true を付ける
        npm install ws --no-save > /dev/null 2>&1
        npm install wrtc --no-save > /dev/null 2>&1 || true
    fi
    node terminal_receiver.js &
    RECEIVER_PID=$!
fi

echo "--- SAGBI AGI is running ---"
echo "Press Ctrl+C to stop all services."

# Keep the script running to maintain the processes
trap "kill $SIGNAL_PID $TUNNEL_PID $RECEIVER_PID; exit" INT TERM
wait