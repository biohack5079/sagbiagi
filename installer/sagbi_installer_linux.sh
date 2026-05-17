#!/usr/bin/env bash
set -euo pipefail

# -------------------
# Constants
# -------------------
OLLAMA_VERSION="v0.24.0"
OLLAMA_URL="https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst"
MODEL="gemma3:4b-it-q4_K_M"
INSTALL_DIR="${HOME}/.sagbi"
BIN_DIR="${HOME}/.local/bin"

# -------------------
# Helper functions
# -------------------
log(){ echo -e "\e[32m[✔]\e[0m $*"; }
err(){ echo -e "\e[31m[✖]\e[0m $*" >&2; }

# -------------------
# 1. Install Ollama binary
# -------------------
mkdir -p "${BIN_DIR}"
if ! command -v ollama > /dev/null || [[ "$(ollama --version 2>&1)" != *"${OLLAMA_VERSION}"* ]]; then
    log "Downloading Ollama ${OLLAMA_VERSION}..."
    curl -L "${OLLAMA_URL}" -o ollama.tar.zst
    log "Extracting Ollama..."
    mkdir -p ollama_tmp
    tar --zstd -xf ollama.tar.zst -C ollama_tmp
    mv ollama_tmp/bin/ollama "${BIN_DIR}/ollama"
    rm -rf ollama_tmp ollama.tar.zst
    log "Ollama installed to ${BIN_DIR}/ollama"
    export PATH="${BIN_DIR}:$PATH"
else
    log "Ollama ${OLLAMA_VERSION} already installed"
fi

# -------------------
# 2. Start Ollama service (Local)
# -------------------
export PATH="${BIN_DIR}:$PATH"
if ! pgrep -x "ollama" > /dev/null; then
    log "Starting Ollama server in background..."
    nohup ollama serve > ollama.log 2>&1 &
    sleep 5
    log "Ollama service started"
else
    log "Ollama service already running"
fi

# -------------------
# 3. Pull default model
# -------------------
log "Pulling default model ${MODEL}..."
# Ensure server is responsive
for i in {1..5}; do
    if curl -s http://localhost:11434/api/tags > /dev/null; then break; fi
    sleep 2
done
ollama pull "${MODEL}"
log "Model ${MODEL} ready"

log "Installation complete!"
