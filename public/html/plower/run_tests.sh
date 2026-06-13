#!/bin/bash

# 実行ディレクトリを取得
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_FILE="$DIR/test_execution.log"
PORT=5173

echo "--- Plower Automated Test Started at $(date) ---" | tee "$LOG_FILE"

# .env ファイルがあれば読み込む
if [ -f "$DIR/.env" ]; then
    export $(grep -v '^#' "$DIR/.env" | xargs)
fi

# Llama等の認証テスト用トークンの案内
if [ -z "$HF_TOKEN" ]; then
    echo "[NOTICE] HF_TOKEN環境変数が未設定です。Llama 3.2等の認証が必要なモデルの自動検証を行うには、" | tee -a "$LOG_FILE"
    echo "         'export HF_TOKEN=your_token' を実行してからスクリプトを起動してください。" | tee -a "$LOG_FILE"
fi

# Vite 開発サーバーの起動 (プロジェクトルートのviteを利用)
echo "Starting Vite dev server on port $PORT..." | tee -a "$LOG_FILE"
npx vite --port $PORT --strictPort > /dev/null 2>&1 &
SERVER_PID=$!

# サーバーがバインドされるまで少し待機
sleep 2

# スクリプト終了時（成功・失敗・中断問わず）にサーバーを停止させる設定
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

# パイプラインの中間の終了ステータスを拾うように設定
set -o pipefail

# Ubuntu 26.04等の対策: システムのブラウザを優先的に使用する環境変数を設定
if command -v chromium-browser > /dev/null; then
    echo "Using system chromium-browser: $(which chromium-browser)" | tee -a "$LOG_FILE"
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium-browser)
elif command -v google-chrome > /dev/null; then
    echo "Using system google-chrome: $(which google-chrome)" | tee -a "$LOG_FILE"
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which google-chrome)
fi

# ブラウザの自動ダウンロードをスキップ (システムブラウザを使用するため)
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Playwrightテストの実行
npx playwright test "$DIR/model_test.spec.ts" --reporter=list --headed 2>&1 | tee -a "$LOG_FILE"
TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "\n[SUCCESS] All tests passed." | tee -a "$LOG_FILE"
else
    echo -e "\n[FAILURE] Some tests failed. Check the log above." | tee -a "$LOG_FILE"
fi

echo "--- Test Ended at $(date) ---" | tee -a "$LOG_FILE"