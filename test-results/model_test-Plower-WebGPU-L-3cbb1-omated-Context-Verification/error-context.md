# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: model_test.spec.ts >> Plower WebGPU Logic Verification >> RAG: File Upload and Automated Context Verification
- Location: model_test.spec.ts:46:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#chatLog')
Expected substring: "9999"
Received string:    "Question: 秘密のコードは何？回答:⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。秘密のコード： 9998RAGソースに加える"

Call log:
  - Expect "toContainText" with timeout 1800000ms
  - waiting for locator('#chatLog')
    3 × locator resolved to <div id="chatLog">…</div>
      - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: 初期化中... (エンジン: WASM)][WASM/CPU推論実行中]"
    2 × locator resolved to <div id="chatLog">…</div>
      - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: モデルダウンロード中: tokenizer.json][WASM/CPU推論実行中]"
    2 × locator resolved to <div id="chatLog">…</div>
      - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: モデルダウンロード中: config.json][WASM/CPU推論実行中]"
    - locator resolved to <div id="chatLog">…</div>
    - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: モデルダウンロード中: generation_config.json][WASM/CPU推論実行中]"
    87 × locator resolved to <div id="chatLog">…</div>
       - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: モデルダウンロード中: onnx/model_q4.onnx][WASM/CPU推論実行中]"
    - locator resolved to <div id="chatLog">…</div>
    - unexpected value "Question: 秘密のコードは何？回答:[WASM/WebGPU Loading: 推論中... (WASM)][WASM/CPU推論実行中]"
    14 × locator resolved to <div id="chatLog">…</div>
       - unexpected value "Question: 秘密のコードは何？回答:⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。[CPU推論中: 0/1024 (0s)]"
    12 × locator resolved to <div id="chatLog">…</div>
       - unexpected value "Question: 秘密のコードは何？回答:⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。秘密[CPU推論中: 1/1024 (7.8s)]"
    14 × locator resolved to <div id="chatLog">…</div>
       - unexpected value "Question: 秘密のコードは何？回答:⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。秘密のコード： [CPU推論中: 2/1024 (14.0s)]"
    13 × locator resolved to <div id="chatLog">…</div>
       - unexpected value "Question: 秘密のコードは何？回答:⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。秘密のコード： 9998RAGソースに加える"

```

```yaml
- paragraph:
  - strong: "Question:"
  - text: 秘密のコードは何？
- paragraph:
  - strong: "回答:"
  - text: ⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。 秘密のコード： 9998
  - button "RAGソースに加える"
```

# Test source

```ts
  1   | import { test, expect, Page } from '@playwright/test';
  2   | 
  3   | /**
  4   |  * Plower WebGPU Model Integration Test (TypeScript Version)
  5   |  */
  6   | 
  7   | const TEST_URL = 'http://localhost:5173/html/plower/index.html'; // Viteのデフォルトポート
  8   | 
  9   | // システムのブラウザを使用するための設定 (describeの外に配置してWorkerエラーを回避)
  10  | test.use({
  11  |   headless: false, // 認証や推論を目視確認できるようにする
  12  |   viewport: { width: 1280, height: 900 },
  13  |   launchOptions: {
  14  |     // 環境変数があればそれを使用し、なければ一般的なパスを試行
  15  |     executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
  16  |     // LinuxのSnap版ブラウザ等で発生しやすいサンドボックス制限を回避
  17  |     args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox'],
  18  |     slowMo: 500,
  19  |   }
  20  | });
  21  | 
  22  | test.describe('Plower WebGPU Logic Verification', () => {
  23  |   const hfToken = process.env.HF_TOKEN;
  24  | 
  25  |   test.beforeEach(async ({ page }: { page: Page }) => {
  26  |     // 全体タイムアウトを30分に設定
  27  |     test.setTimeout(1800000); 
  28  |     await page.goto(TEST_URL);
  29  |   });
  30  | 
  31  |   test('Environment: Reset WebGPU Cache', async ({ page }) => {
  32  |     // キャッシュクリアは IndexedDB 等を巡回するため少し時間を取る
  33  |     test.setTimeout(120000);
  34  |     page.on('dialog', async dialog => {
  35  |       if (dialog.type() === 'confirm' || dialog.type() === 'alert') {
  36  |         await dialog.accept();
  37  |       }
  38  |     });
  39  |     const clearBtn = page.locator('#clearWebGpuCacheButton');
  40  |     await clearBtn.scrollIntoViewIfNeeded();
  41  |     await clearBtn.click();
  42  |     await page.waitForLoadState('networkidle');
  43  |     console.log('WebGPU model cache cleared successfully.');
  44  |   });
  45  | 
  46  |   test('RAG: File Upload and Automated Context Verification', async ({ page }) => {
  47  |     test.slow(); // このテストは時間がかかることを明示
  48  |     const fileName = 'rag_test_file.txt';
  49  |     const fileContent = 'このドキュメントには「秘密のコード: 9999」が含まれています。';
  50  |     
  51  |     // ファイルのアップロードを自動化
  52  |     await page.setInputFiles('#fileInput', {
  53  |       name: fileName,
  54  |       mimeType: 'text/plain',
  55  |       buffer: Buffer.from(fileContent)
  56  |     });
  57  |     await expect(page.locator('#fileListUl')).toContainText(fileName);
  58  | 
  59  |     await page.selectOption('#modelSelect', 'webgpu:onnx-community/Qwen2.5-0.5B-Instruct');
  60  |     await page.fill('#userInput', '秘密のコードは何？');
  61  |     await page.click('#sendButton');
  62  | 
  63  |     // 数値の正確性を検証 (Qwen 0.5B のハルシネーション対策済みか)
  64  |     const chatLog = page.locator('#chatLog');
> 65  |     await expect(chatLog).toContainText('9999', { timeout: 1800000 });
      |                           ^ Error: expect(locator).toContainText(expected) failed
  66  |     await expect(chatLog).not.toContainText('9998'); 
  67  |     console.log('RAG file upload automation passed.');
  68  |   });
  69  | 
  70  |   test('Reasoning Test: Should detect urgent meeting in 10 minutes (Qwen)', async ({ page }: { page: Page }) => {
  71  |     // RAGコンテキスト注入
  72  |     const context = "現在 09:50。10:00 会議開始。移動に10分。";
  73  |     await page.fill('#pasteArea', context);
  74  | 
  75  |     // 軽量モデル選択
  76  |     await page.selectOption('#modelSelect', 'webgpu:onnx-community/Qwen2.5-0.5B-Instruct');
  77  | 
  78  |     // 推論開始
  79  |     await page.fill('#userInput', 'あと10分でどうなりますか？');
  80  |     await page.click('#sendButton');
  81  | 
  82  |     // 回答に「遅刻」や「間に合わない」という文脈が含まれるか検証
  83  |     const chatLog = page.locator('#chatLog');
  84  |     await expect(chatLog).toContainText(/(遅刻|間に合わない|すぐに出|出発|急いで|でなくちゃ)/, { timeout: 1500000 });
  85  |     console.log('Qwen reasoning test passed.');
  86  |   });
  87  | 
  88  |   test('GPT-2: Should download and infer without auth dialog', async ({ page }: { page: Page }) => {
  89  |     // GPT-2は公開モデルなので認証ダイアログが出ないことを確認
  90  |     await page.selectOption('#modelSelect', 'webgpu:onnx-community/gpt2-medium-ONNX');
  91  |     await page.fill('#userInput', 'Hello, what is your purpose?');
  92  |     await page.click('#sendButton');
  93  | 
  94  |     // 認証ダイアログが表示されていないことを確認
  95  |     const authDialog = page.locator('h3:has-text("認証が必要です"), h3:has-text("License Required")');
  96  |     await expect(authDialog).not.toBeVisible({ timeout: 5000 });
  97  | 
  98  |     // モデルがロードされ、何らかの回答が生成されることを確認
  99  |     const chatLog = page.locator('#chatLog');
  100 |     await expect(chatLog).toContainText(/Hello|AI|language|model/i, { timeout: 60000 });
  101 |     console.log('GPT-2 test passed: Downloaded and inferred without auth dialog.');
  102 |   });
  103 | 
  104 |   test('Llama 3.2: Should show HF Auth Dialog when token is missing', async ({ page }: { page: Page }) => {
  105 |     // localStorageからHFトークンをクリア
  106 |     await page.evaluate(() => localStorage.removeItem('plowerHfToken'));
  107 |     await page.reload({ waitUntil: 'networkidle' }); 
  108 | 
  109 |     await page.selectOption('#modelSelect', 'webgpu:onnx-community/Llama-3.2-1B-Instruct');
  110 |     await page.fill('#userInput', 'Hello');
  111 |     await page.click('#sendButton');
  112 | 
  113 |     // 認証ダイアログが表示されるのを待つ (モデルのメタデータ取得等があるため長めに待機)
  114 |     const authDialog = page.locator('h3:has-text("認証が必要です"), h3:has-text("License Required")');
  115 |     await expect(authDialog).toBeVisible({ timeout: 60000 });
  116 | 
  117 |     // ダイアログまでスクロール (Viewportエラー対策)
  118 |     await authDialog.scrollIntoViewIfNeeded();
  119 | 
  120 |     const tokenInput = page.locator('#authDialogToken');
  121 |     await expect(tokenInput).toBeVisible();
  122 | 
  123 |     if (hfToken) {
  124 |       console.log('Automating Llama 3.2 token entry using environment variable...');
  125 |       await tokenInput.fill(hfToken);
  126 |       await page.click('#authDialogRetry');
  127 |       await expect(authDialog).not.toBeVisible({ timeout: 180000 });
  128 |       console.log('Llama 3.2 token entry automation passed.');
  129 |     } else {
  130 |       console.warn('HF_TOKEN environment variable is not set. Testing manual cancellation.');
  131 |       await page.click('#authDialogCancel');
  132 |       await expect(authDialog).not.toBeVisible();
  133 |     }
  134 |   });
  135 | 
  136 |   test('Llama 3.2: Reasoning Test (Automated if HF_TOKEN is set)', async ({ page }: { page: Page }) => {
  137 |     test.slow();
  138 |     if (!hfToken) {
  139 |       console.log('Skipping Llama 3.2 Reasoning Test because HF_TOKEN is not set.');
  140 |       return;
  141 |     }
  142 |     // トークンを事前セットしてリロード (ダイアログなしで開始できるか検証)
  143 |     await page.evaluate((token) => localStorage.setItem('plowerHfToken', token), hfToken);
  144 |     await page.reload({ waitUntil: 'networkidle' });
  145 | 
  146 |     const context = "現在 09:50。10:00 会議開始。移動に10分。";
  147 |     await page.fill('#pasteArea', context);
  148 |     await page.selectOption('#modelSelect', 'webgpu:onnx-community/Llama-3.2-1B-Instruct');
  149 |     await page.fill('#userInput', 'あと10分でどうなりますか？');
  150 |     await page.click('#sendButton');
  151 | 
  152 |     const chatLog = page.locator('#chatLog');
  153 |     // Llama 3.2 の巨大さとWASM推論速度を考慮し、20分まで許容
  154 |     await expect(chatLog).toContainText(/(遅刻|間に合わない|すぐに出|出発|急いで|でなくちゃ|10:00)/, { timeout: 1200000 });
  155 |     console.log('Llama 3.2 automated reasoning test passed.');
  156 |   });
  157 | 
  158 |   test('Storage Check: Log exists', async ({ page }: { page: Page }) => {
  159 |     const logs: string[] = [];
  160 |     page.on('console', msg => logs.push(msg.text()));
  161 |     await page.reload();
  162 |     expect(logs.some(l => l.includes('[Storage]'))).toBeTruthy();
  163 |   });
  164 | });
```