# kubectl のインストール
sudo snap install kubectl --classic

# Docker のインストール (もしまだの場合)
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker $USER && newgrp docker

# kind (Kubernetes in Docker) のインストール
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.27.0/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind
