# Development Guide for SAGBI Linux Installer and Ollama + K8s Setup

## Overview
This document explains how to create a Linux version of the **SAGBI installer** and how to deploy the **Ollama** inference engine together with the **Go signaling server** onto a Kubernetes cluster. The steps are fully scripted so you can repeat the process on any Linux host (Ubuntu 22.04+, Debian, or any distro with Docker/Kubernetes support).

---
### 1️⃣ Prerequisites
| Tool | Minimum Version | Install Command |
|------|----------------|-----------------|
| `docker` | 20.10+ | `sudo apt-get install -y docker.io` |
| `kubectl` | 1.27+ | `curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl` |
| `helm` | 3.12+ | `curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash` |
| `git` | any | `sudo apt-get install -y git` |
| `curl` | any | `sudo apt-get install -y curl` |
| `make` (optional) | any | `sudo apt-get install -y build-essential` |

Make sure your user is added to the `docker` group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

---
### 2️⃣ Build the Linux Installer (bash script)
A lightweight installer is provided as **`installer/sagbi_installer_linux.sh`**. It performs the following actions on the target machine:
1. Installs **Ollama** (official binary) if not present.
2. Pulls the default model `gemma3:4b-it-q4_K_M`.
3. Installs optional extra models.
4. Creates a desktop shortcut that launches the **SAGBI** web UI (pointing at your K8s‑exposed endpoint).

The script is deliberately **self‑contained** – it does not require any compiled binaries, only the tools listed above.

#### 2.1 Create the Script
```bash
#!/usr/bin/env bash
set -euo pipefail

# -------------------
# Constants
# -------------------
OLLAMA_URL="https://github.com/jmorganca/ollama/releases/download/v0.3.9/ollama-linux-amd64" # Adjust version if newer
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
    log "Downloading Ollama binary..."
    curl -L "${OLLAMA_URL}" -o "${HOME}/ollama"
    chmod +x "${HOME}/ollama"
    sudo mv "${HOME}/ollama" /usr/local/bin/ollama
    log "Ollama installed to /usr/local/bin"
else
    log "Ollama already installed"
fi

# -------------------
# 2. Start Ollama service (systemd) if not running
# -------------------
if ! systemctl is-active --quiet ollama; then
    log "Creating systemd service for Ollama..."
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
    log "Ollama service started"
else
    log "Ollama service already running"
fi

# -------------------
# 3. Pull default model
# -------------------
log "Pulling default model ${MODEL}..."
ollama pull "${MODEL}"
log "Model ${MODEL} ready"

# -------------------
# 3.5 RAG Directory Configuration
# -------------------
echo "-------------------------------------------------------"
echo "RAGソース参照ファイルを保存するフォルダのフルパスを入力してください。"
echo "（未入力の場合はRAG機能がデフォルトで無効になります）"
read -p "Path: " RAG_PATH

if [ -z "$RAG_PATH" ]; then
    log "RAG設定をスキップしました。"
else
    echo "警告: ここが以降の参照フォルダになります。個人情報などは保存しないで下さい。"
    mkdir -p "signaling"
    echo "RAG_DIR=$RAG_PATH" > signaling/.env
    log "RAGディレクトリを $RAG_PATH に設定し、signaling/.env に保存しました。"
fi

echo "-------------------------------------------------------"
echo "会話履歴（ログ）を保存するフォルダのフルパスを入力してください。"
echo "（GitHub管理外のディレクトリを推奨します。未入力なら保存しません）"
read -p "History Path: " HIST_PATH

if [ -z "$HIST_PATH" ]; then
    log "履歴保存を無効にしました。"
else
    mkdir -p "$HIST_PATH"
    echo "HISTORY_DIR=$HIST_PATH" >> signaling/.env
    log "履歴保存先を $HIST_PATH に設定しました。"
fi

# -------------------
# 4. Optional: Pull extra models (example)
# -------------------
# EXTRA_MODELS=("phi:2.7b" "llama2:13b")
# for m in "${EXTRA_MODELS[@]}"; do
#     log "Pulling extra model $m..."
#     ollama pull "$m"
# done

# -------------------
# 5. Create launch shortcut (desktop entry)
# -------------------
mkdir -p "${INSTALL_DIR}"
cat > "${HOME}/Desktop/SAGBI.desktop" <<EOF
[Desktop Entry]
Name=SAGBI AGI (Linux)
Comment=Launch SAGBI web UI with local Ollama backend
Exec=xdg-open http://localhost:8080
Icon=utilities-terminal
Terminal=false
Type=Application
Categories=Network;Utility;
EOF
chmod +x "${HOME}/Desktop/SAGBI.desktop"
log "Desktop shortcut created at ~/Desktop/SAGBI.desktop"

log "Installation complete!"
```

Save this script as **`installer/sagbi_installer_linux.sh`** and make it executable:
```bash
chmod +x installer/sagbi_installer_linux.sh
```
Distribute it via your GitHub releases (e.g., `sagbi_installer_linux.sh`).

---
### 3️⃣ Deploy Ollama & Signaling Server on Kubernetes
The Kubernetes manifests are already present under `k8s/`. Below is a concise walk‑through of each component.

#### 3.1 Namespace
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sagbi
```
Create it with:
```bash
kubectl apply -f k8s/namespace.yaml
```
#### 3.2 Ollama Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: sagbi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ollama
  template:
    metadata:
      labels:
        app: ollama
    spec:
      containers:
      - name: ollama
        image: ollama/ollama:latest
        ports:
        - containerPort: 11434
        resources:
          limits:
            cpu: "2"
            memory: "4Gi"
        securityContext:
          runAsUser: 1000
          runAsGroup: 1000
```
Apply:
```bash
kubectl apply -f k8s/ollama-deployment.yaml
```
#### 3.3 Signaling Server Deployment (Go)
The Dockerfile under `signaling/` builds the Go binary. Build & push the image (replace `<your-registry>`):
```bash
cd signaling
docker build -t <your-registry>/sagbi-signaler:latest .
# push to registry
docker push <your-registry>/sagbi-signaler:latest
```
Create the K8s manifest (example `signaler-deployment.yaml`):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: signaler
  namespace: sagbi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: signaler
  template:
    metadata:
      labels:
        app: signaler
    spec:
      containers:
      - name: signaler
        image: <your-registry>/sagbi-signaler:latest
        env:
        - name: OLLAMA_URL
          value: "http://ollama:11434"
        ports:
        - containerPort: 8080
```
Apply:
```bash
kubectl apply -f k8s/signal-deployment.yaml
```
#### 3.4 Service & Ingress
```yaml
apiVersion: v1
kind: Service
metadata:
  name: sagbi-service
  namespace: sagbi
spec:
  selector:
    app: signaler
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sagbi-ingress
  namespace: sagbi
  annotations:
    kubernetes.io/ingress.class: "nginx"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - sagbi.example.com
    secretName: sagbi-tls
  rules:
  - host: sagbi.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: sagbi-service
            port:
              number: 80
```
Apply both files:
```bash
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```
After the ingress is ready, the **frontend** can reach the signaling server at `wss://sagbi.example.com` and the **Ollama** container will serve the model locally inside the cluster.

---
### 4️⃣ Local Development / Testing
1. **Run Docker compose locally** (for quick iteration):
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
    environment:
      - OLLAMA_URL=http://ollama:11434
    ports:
      - "8080:8080"
    depends_on:
      - ollama
```
Run:
```bash
docker compose up -d
```
2. **Test WebSocket** from the browser console:
```js
const ws = new WebSocket('ws://localhost:8080/ws');
ws.onopen = () => ws.send(JSON.stringify({type:'ping'}));
ws.onmessage = e => console.log('msg', e.data);
```
3. **Validate Model** via curl:
```bash
curl -X POST http://localhost:11434/api/generate -d '{"model":"gemma3:4b-it-q4_K_M","prompt":"Say hello"}'
```
If you see a JSON response with generated text, the stack is functional.

### 4.1 Verification Commands (K8s)
To ensure everything is running correctly in Kubernetes, use these commands:

1. **Check Pod Status**:
   `kubectl get pods -n sagbi`
2. **Check Ollama Version (Must be 0.5.7+ for Gemma 3)**:
   `kubectl exec -it -n sagbi deployment/ollama -- ollama --version`
3. **Verify Model is Pulled**:
   `kubectl exec -it -n sagbi deployment/ollama -- ollama list`
4. **Test Inference Inside Cluster**:
   `kubectl exec -it -n sagbi deployment/ollama -- ollama run gemma3:4b-it-q4_K_M "Hello"`
5. **Check Signaler Logs**:
   `kubectl logs -n sagbi -l app=signaler`
6. **Verify Signaling Health**:
   `kubectl exec -it -n sagbi deployment/signaler -- curl -s http://localhost:8080/healthz`

---
### 5️⃣ Distribution
1. **GitHub Releases**
   - Upload `sagbi_installer_linux.sh` and the Windows `sagbi_install.exe`.
   - Update `public/html/index.html` links to point at the appropriate asset (already done for Windows, add similar Linux link).
2. **Documentation**
   - Add a short “Installation” section to the README linking to this **Development.md** for power‑users.

---
## 🎉 Done!
You now have:
- A ready‑to‑run Linux installer script.
- Full step‑by‑step K8s deployment instructions for Ollama + the Go signaling server.
- Updated documentation to guide developers and end‑users.

Feel free to tweak versions, add extra models, or integrate a CI pipeline that automatically builds and pushes the Docker images.
