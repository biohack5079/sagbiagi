#!/bin/bash
GO_VERSION="1.22.3"
URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
DEST="$HOME/local_go"
mkdir -p "$DEST"
if [ ! -d "$DEST/go" ]; then
    echo "Downloading Go ${GO_VERSION}..."
    curl -LO "$URL"
    tar -C "$DEST" -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
    rm "go${GO_VERSION}.linux-amd64.tar.gz"
fi
export PATH="$DEST/go/bin:$PATH"
go version
