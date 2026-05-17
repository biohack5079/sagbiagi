# SAGBI Installer

Windows 用の SAGBI インストーラー実行ファイルのビルドおよび使用ガイドです。

## 概要

このインストーラーは以下の機能を備えています：

1. **Ollama のダウンロード・インストール** — Windows 環境に Ollama をセットアップ
2. **デフォルトモデルの自動プル** — `gemma3:4b-it-q4_K_M` をダウンロード
3. **追加モデルの対応** — ユーザーが他のモデルを追加可能
4. **自動起動** — インストール完了後、SAGBI AGI ホームページをブラウザで起動

## ファイル構成

```
installer/
├── sagbi_installer.cpp      # インストーラーのソースコード (C++ / Win32 API)
├── CMakeLists.txt           # CMake ビルド設定
├── sagbi_install.exe        # コンパイル済み実行ファイル（生成済み）
└── README.md                # このファイル
```

## インストーラーの使用方法

### Windows での実行

1. `sagbi_install.exe` をダウンロード
2. ファイルをダブルクリックして実行
3. ウィザードに従ってインストール完了
4. 自動でブラウザが起動します

### 動作環境

- **OS**: Windows 7 以上（64 ビット）
- **アーキテクチャ**: x86-64
- **インターネット接続**: 必須（Ollama・モデルのダウンロード）

## ビルド方法

### 前提条件

- CMake 3.15 以上
- MinGW-w64 または MSVC コンパイラ

### CMake でのビルド（推奨）

```bash
cd installer
mkdir build
cd build
cmake ..
cmake --build .
```

**出力**: `installer/build/sagbi_install.exe`

### MinGW での直接ビルド

```bash
cd installer
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp \
  -lshell32 -lurlmon -luser32 -mwindows -static
```

**出力**: `installer/sagbi_install.exe`

### MSVC でのビルド

```cmd
cd installer
cl /EHsc /Fe:sagbi_install.exe sagbi_installer.cpp shell32.lib urlmon.lib user32.lib
```

**出力**: `installer/sagbi_install.exe`

## 実行ファイルの配布

### ダウンロードサイト用

コンパイル済みの `sagbi_install.exe` を以下に配置してください：

```
public/downloads/
├── sagbi_install.exe        # インストーラー本体
├── README_JP.txt            # 日本語インストール手順
├── README.txt               # 英語インストール手順
└── VERSION.txt              # バージョン情報
```

### バージョン管理

- **ファイル名**: `sagbi_install_v1.0.0.exe` （バージョン付き）
- **チェックサム**: SHA256 ハッシュを公開
- **リリースノート**: 各バージョンの変更内容を記載

## トラブルシューティング

### 実行時エラー: "library not found"

**原因**: 静的リンクが不完全な可能性

**解決方法**:
```bash
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp \
  -lshell32 -lurlmon -luser32 -mwindows -static-libgcc -static-libstdc++
```

### インストール中にネットワークエラー

**原因**: インターネット接続の問題

**解決方法**:
- インターネット接続を確認
- ファイアウォール設定を確認
- インストーラーを管理者権限で実行

### Ollama が起動しない

**原因**: Windows Update または依存ライブラリ不足

**解決方法**:
- Windows を最新バージョンに更新
- Visual C++ 再頒布可能パッケージをインストール

## ソースコード

### サポート機能

- **Win32 API**: ウィンドウ、ダイアログ、メッセージボックス
- **URLMon**: HTTP ダウンロード機能
- **Shell32**: 外部プログラムの実行

### リンク情報

- `shell32.lib` — Windows シェル機能
- `urlmon.lib` — URL ダウンロード
- `user32.lib` — ウィンドウ管理

## ライセンス

このプロジェクトのライセンスについては、親プロジェクトのドキュメントを参照してください。

## サポート

問題が発生した場合は、以下の情報を提供してください：

- Windows バージョン
- エラーメッセージの全文
- インストーラーのバージョン
- ネットワーク環境（プロキシ使用の有無など）

## 更新履歴

### v1.0.0 (2026-05-15)

- 初版リリース
- Ollama インストール機能
- デフォルトモデル自動プル
- Windows GUI ウィザード
