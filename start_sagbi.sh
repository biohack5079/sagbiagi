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

# 以前のプロセスが残っていたら掃除する
if command -v lsof >/dev/null && lsof -Pi :$CHECK_PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "Port $CHECK_PORT is already in use. Cleaning up old process..."
    fuser -k $CHECK_PORT/tcp >/dev/null 2>&1 || true
    sleep 1
fi

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

echo "[3/3] Updating Cloudflare Worker Endpoint..."

# wranglerを使って、Workerの環境変数「TUNNEL_URL」を最新のURLに上書きする
wrangler secret put TUNNEL_URL --secret-text "$CLOUDFLARE_URL" --name sagbi

echo "Worker endpoint updated successfully!"
echo "(Skipped firebase deploy. Your Firebase config is perfectly safe!)"

echo -e "\nTunnel Ready: $CLOUDFLARE_URL"
echo "Opening Global SAGBI URL..."

# 3. Open Browser
FINAL_URL="https://sagbiagi.web.app/"
echo "Target URL: $FINAL_URL"

if command -v xdg-open > /dev/null; then
    xdg-open "$FINAL_URL" > /dev/null 2>&1
elif command -v open > /dev/null; then
    open "$FINAL_URL" > /dev/null 2>&1
else
    echo "Please open this URL manually: $FINAL_URL"
fi

echo -e "\n--- Smartphone Access ---"
if command -v qrencode > /dev/null; then
    echo "Scan this QR code with your smartphone to join:"
    qrencode -t ansiutf8 "$FINAL_URL"
else
    echo "Tip: Install 'qrencode' to display a QR code here for easy mobile access."
fi

echo "--- SAGBI AGI is running ---"
echo "Press Ctrl+C to stop all services."

# Keep the script running to maintain the processes
trap "kill $SIGNAL_PID $TUNNEL_PID; exit" INT TERM
wait
