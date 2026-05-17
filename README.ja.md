# SAGBI AGI — 分散型ローカルAIエージェントプラットフォーム

他の言語: English

> **元気玉コンピューティング**: 全員のPCを接続して、巨大な分散型AIエージェントを動かす。

SAGBI AGIは、一般的なコンシューマーハードウェアを協調型スーパーコンピューターに変える、分散型人工汎用知能（AGI）プラットフォームです。各参加者は、P2Pメッシュネットワークを通じて余剰のCPU、メモリ、GPUリソースを共有する軽量エージェントをインストールします。複雑な質問が投げかけられると、システムは推論ワークロードをネットワーク全体に自動的に分散させます。まさにデジタルの「元気玉」です。

---

## 🚀 クイックスタート

1. **インストーラーの実行**: `installer/` フォルダにある各OS用のインストーラーを実行し、Ollamaをセットアップします。
2. **サーバー起動**: ターミナルで `./start_sagbi.sh` を実行します。
3. **ブラウザアクセス**: 自動的にブラウザが開き、AIチャット画面が表示されます。

### 📱 スマホとの共有
起動時にターミナルに表示される **QRコード** をスマホでスキャンしてください。Cloudflare Tunnel経由で、どこからでもPCのAIを利用できます。**質問と回答の両方が、接続されている全デバイスでリアルタイムに同期**されます。

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────────┐
│                        エンドユーザー (ブラウザ)                    │
│   ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│   │  index.html  │   │   chat.js    │   │  three.js Agent    │  │
│   │  (Firebase)  │   │  (WebSocket) │   │  (GLB Preview)     │  │
│   └──────┬───────┘   └──────┬───────┘   └────────────────────┘  │
│          │                  │                                    │
│          │     wss://       │                                    │
└──────────┼──────────────────┼────────────────────────────────────┘
           │                  │
    ┌──────▼──────────────────▼──────┐
    │   Cloudflare Tunnel (Ingress)  │
    └──────────────┬─────────────────┘
                   │
    ┌──────────────▼─────────────────────────────────────────┐
    │              Ubuntu K8s Cluster (Kind)                  │
    │                                                        │
    │   ┌────────────────────┐   ┌────────────────────────┐  │
    │   │  sagbi-signaling   │   │       ollama            │  │
    │   │  (Go / WebSocket)  │──▶│  (gemma3:4b-it-q4_K_M) │  │
    │   │  :8080             │   │  :11434                 │  │
    │   └────────────────────┘   └────────────────────────┘  │
    │                                                        │
    │   ┌────────────────────────────────────────────────┐   │
    │   │  将来構想: 分散ワーカーノード (P2P Mesh)          │   │
    │   │  - モデル並列推論のための WebRTC DataChannel     │   │
    │   │  - ノード発見のための Libp2p                    │   │
    │   │  - アイドルノードへの K8s 自動スケジューリング    │   │
    │   └────────────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────────┘
```

---

## コンポーネント

### 1. フロントエンド — Firebase Hosting

| ファイル | 説明 |
|------|-------------|
| `public/html/index.html` | メインのランディングページ。株価評価計算機とAIチャットサイドバーを搭載 |
| `public/html/chat.js` | WebSocketクライアント + three.jsによるGLBエージェントレンダラー |
| `public/html/downloads/` | Windowsインストーラー (`sagbi_install.exe`) をホスト |

**チャットサイドバーの機能**:
- グラスモーフィズムを採用したフローティングパネル
- GoシグナリングサーバーへのリアルタイムWebSocket接続
- three.jsによるミニ3Dアバタープレビュー (`g1-m_chan.glb`)
- 指数バックオフによる自動再接続
- レスポンシブデザイン（モバイル対応）

### 2. シグナリングサーバー — Go (WebSocket)

このサーバーはシステムの「交換手」として機能します。
- ブラウザクライアントからのWebSocket接続の受付
- チャットメッセージをローカルのOllamaインスタンスへ転送
- P2PメッシュのためのWebRTCシグナリング（Offer/Answer/ICE candidates）の中継

### 3. AIバックエンド — Ollama

Kubernetesクラスター内でコンテナ化されたサービスとして動作し、`gemma3:4b-it-q4_K_M` モデルを提供します。

---

## Kubernetes デプロイメント

**Kindへのデプロイ**:
```bash
# クラスター作成
kind create cluster --name sagbi

# ローカルイメージのロード
kind load docker-image sagbi-signaling:latest --name sagbi
kind load docker-image ollama/ollama:latest --name sagbi

# マニフェストの適用
kubectl apply -f k8s/deployment.yaml

# Ollamaポッド内でモデルをプル
kubectl exec -it deployment/ollama -- ollama pull gemma3:4b-it-q4_K_M
```

---

## Windows インストーラー (C++)

ワンクリックでセットアップ可能な体験を提供します。
1. Ollama公式サイトから `OllamaSetup.exe` をダウンロード
2. Ollamaのサイレントインストールを実行
3. 自動的に `gemma3:4b-it-q4_K_M` をプル
4. 完了後、SAGBI AGIのホームページを自動で開く

---

## 分散コンピューティングのビジョン

### 仕組み

1. **シグナリング & クラスタリング (Go)**
   各ユーザーのPCで動作するGoプログラムが、WebSocketやLibp2pを使用してP2Pメッシュに接続します。ノードはリソースの空き状況（GPUのVRAMやCPUのアイドル状況）を常に監視・共有します。

2. **コンテナ自動スケジューリング (Kubernetes)**
   複雑なタスクが投入されると、K8sが最適なリソースを持つノードに専用コンテナ（検索、コード実行、推論）をデプロイします。

3. **データ並列・モデル並列推論 (Ollama + WebRTC)**
   重い推論タスクはWebRTC DataChannelを通じて複数のPCに分割されます。

---

## 関連サービス

| サービス | URL | 説明 |
|---------|-----|-------------|
| Plower | sagbuntu.web.app/plower.html | ローカルRAG（検索拡張生成）アプリ |
| Cybernet Call | cybernetcall.onrender.com | P2P通信プラットフォーム |
| G1:M Avatar | g1m-pwa.onrender.com | モーションキャプチャ対応3Dアバターサービス |
| HuggingFace | G1mAvaterUniverse | モデルホスティングと推論エンドポイント |

---

## プロジェクト構造

```
sagbi/
├── public/html/              # フロントエンド (Firebase Hosting)
│   ├── index.html            # ランディングページ + チャットサイドバー
│   ├── chat.js               # WebSocketチャット + three.jsエージェント
│   └── downloads/            # インストーラーのホスティング
├── signaling/                # Goシグナリングサーバー
├── k8s/                      # Kubernetesマニフェスト
├── installer/                # Windowsインストーラー
└── README.md                 # ← 英語版
└── README.ja.md              # ← 日本語版 (このファイル)
```

---

## ライセンス

© 2036 SAGBI AGI / Biohack5079. All rights reserved.

---

## 貢献について

これは実験的な分散型AIプラットフォームです。コントリビューション、アイデア、ノードへの参加を歓迎します。GitHubでIssueを作成するか、Pull Requestを送信してください。