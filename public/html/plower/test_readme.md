# Plower WebGPU モデル統合テスト

このディレクトリ配下のテストコードは、Plowerで利用可能なWebGPUモデル（Qwen, Llama, Gemma等）のロード、HF認証、および推論精度の検証を自動で行います。

## 準備 (初回のみ)
必ずプロジェクトの**ルートディレクトリ** (`~/Documents/d/sagbiagi/`) で以下のコマンドを実行してください。

```bash
# 1. 依存ライブラリのインストール
npm install

# 2. Linux環境で必要なシステムパッケージのインストール
sudo npx playwright install-deps

# 3. Playwright用ブラウザのインストール
npx playwright install
```

## テストの実行
Plowerのディレクトリに移動し、シェルスクリプトを実行します。Vite開発サーバーの起動からテスト、ログ保存まで一括で行われます。
```bash
cd public/html/plower/
chmod +x run_tests.sh
./run_tests.sh
```

export HF_TOKEN=あなたのHuggingFaceトークン
./run_tests.sh


## 検証内容
- **推論精度テスト**: 「10分後に会議がある」という文脈を与え、「あと10分でどうなりますか？」という質問に対し、AIが「遅刻」や「出発の必要性」を正しく判断できるかを確認します。
- **HF認証ダイアログ**: LlamaやGemmaなどのGatedモデルを選択した際、適切にトークン入力ダイアログが表示されるかを確認します。
- **ストレージチェック**: ブラウザのストレージ容量（WebGPUモデル用キャッシュ）のログが出力されているか確認します。

## ログファイル
実行結果は同一ディレクトリ内の `test_execution.log` に出力されます。
このファイルは `.gitignore` によりGit管理から除外されています。