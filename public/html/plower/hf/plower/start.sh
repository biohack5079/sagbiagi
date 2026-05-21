#!/bin/bash

# Spaceの設定画面(Variables)での入力ミスを強制的に修正
export OLLAMA_HOST=0.0.0.0:7860
# 本番環境とローカル環境(localhost)からのアクセスを許可します
export OLLAMA_ORIGINS="https://sagbuntu.web.app,http://localhost:*,http://127.0.0.1:*"

# Ollamaサーバーをバックグラウンドで起動
ollama serve &
pid=$!

# サーバーが立ち上がるまで少し待機
sleep 5

echo "🔴 モデルの準備を確認します..."

# ビルド時に作成したカスタムモデルが存在するか確認
echo "--- Checking gemma3:4b-it-q4_K_M ---"
ollama list | grep "gemma3:4b-it-q4_K_M"

echo "🟢 すべてのモデルの準備が完了しました！ (Using: gemma3:4b-it-q4_K_M)"

# プロセスが終了しないように待機
wait $pid
