# sagbi_install.exe ビルドガイド

Windows 環境での `sagbi_install.exe` のコンパイル方法をまとめました。

## ビルド環境

- **対応コンパイラ**
  - MSVC (Microsoft Visual C++)
  - MinGW (x86_64-w64-mingw32)
  - CMake 3.15 以上

---

## 方法1: CMake を使用したビルド（推奨）

### ステップ1: ビルドディレクトリを作成

```bash
cd installer
mkdir build
cd build
```

### ステップ2: CMake で設定

```bash
cmake ..
```

### ステップ3: ビルド実行

```bash
cmake --build .
```

### 出力場所

```
installer/build/sagbi_install.exe
```

---

## 方法2: MSVC で直接コンパイル

### コマンド

```cmd
cd installer
cl /EHsc /Fe:sagbi_install.exe sagbi_installer.cpp shell32.lib urlmon.lib user32.lib
```

### 出力場所

```
installer/sagbi_install.exe
```

または `/Fe:` オプションで指定したパス

---

## 方法3: MinGW で直接コンパイル

### コマンド

```bash
cd installer
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp \
  -lshell32 -lurlmon -luser32 -mwindows -static
```

### 出力場所

```
installer/sagbi_install.exe
```

### オプション説明

| オプション | 説明 |
|-----------|------|
| `-o sagbi_install.exe` | 出力ファイル名を指定 |
| `-lshell32 -lurlmon -luser32` | 必要なライブラリをリンク |
| `-mwindows` | Windows GUI アプリケーションとしてビルド |
| `-static` | 静的リンク（スタンドアロン exe を生成） |

---

## コンパイル後の配置

### 推奨配置例

ビルド完了後、`sagbi_install.exe` を以下のいずれかに配置してください：

1. **ダウンロードサイト用** → `public/downloads/sagbi_install.exe`
2. **CI/CD デプロイ用** → 専用ディレクトリ
3. **リリース用** → `releases/` または `dist/`

### ファイル配布の例

```
public/downloads/
  ├── sagbi_install.exe
  ├── README.txt (インストール手順)
  └── VERSION.txt (バージョン情報)
```

---

## トラブルシューティング

### エラー: `urlmon.h` が見つからない

**原因**: Windows SDK が未インストール

**解決方法**:
- Visual Studio に "Desktop development with C++" をインストール
- または単体の Windows SDK をダウンロード

### エラー: MinGW コンパイラが見つからない

**原因**: MinGW パッケージが未インストール

**解決方法**:
```bash
# Windows (Chocolatey)
choco install mingw

# Linux (クロスコンパイル)
sudo apt-get install mingw-w64
```

### エラー: コンパイルは成功したが exe が動作しない

**原因**: 必要なライブラリが静的リンクされていない可能性

**解決方法**: `-static` フラグでビルド

```bash
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp \
  -lshell32 -lurlmon -luser32 -mwindows -static
```

---

## ソースコード

- **メインファイル**: `sagbi_installer.cpp`
- **ビルド設定**: `CMakeLists.txt`

### 機能

1. Ollama をダウンロード・インストール
2. デフォルトモデル (`gemma3:4b-it-q4_K_M`) をプル
3. 追加モデルの追加に対応
4. 完了後に SAGBI AGI ホームページを起動
