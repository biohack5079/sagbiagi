FROM ollama/ollama:latest

# Hugging Face Spacesの推奨設定 (UID 1000)
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH
WORKDIR $HOME

# 権限設定のために一時的にrootユーザーへ切り替え
USER root

# 必要なツールのインストールとディレクトリ作成
# これにより "permission denied" エラーを防ぎます
RUN apt-get update && apt-get install -y curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p $HOME/.ollama/models && \
    chown -R 1000:1000 $HOME

# 起動スクリプトをコピーして実行権限を付与
COPY start.sh .
RUN chmod +x start.sh && \
    chown 1000:1000 start.sh

# 環境変数の設定
# ポート7860はHugging Face Spacesの要件
ENV OLLAMA_HOST=0.0.0.0:7860
ENV OLLAMA_ORIGINS="https://sagbuntu.web.app,http://localhost:*,http://127.0.0.1:*"
ENV OLLAMA_MODELS=$HOME/.ollama/models

# 実行ユーザーをUID 1000に切り替え
USER 1000

# モデルのプリインストール (GGUFを直接ダウンロードしてカスタムモデルを作成)
RUN (ollama serve &) && \
    until ollama list >/dev/null 2>&1; do sleep 1; done && \
    ollama pull gemma3:4b-it-q4_K_M && \
    pkill ollama

# 【重要】ベースイメージのENTRYPOINT（ollamaコマンドの自動実行）を無効化します
ENTRYPOINT []

# シェルスクリプトを起動コマンドとして指定
CMD ["./start.sh"]
