import { test, expect, Page } from '@playwright/test';

/**
 * Plower WebGPU Model Integration Test (TypeScript Version)
 */

const TEST_URL = 'http://localhost:5173/html/plower/index.html'; // Viteのデフォルトポート

// システムのブラウザを使用するための設定 (describeの外に配置してWorkerエラーを回避)
test.use({
  headless: false, // 認証や推論を目視確認できるようにする
  viewport: { width: 1280, height: 900 },
  launchOptions: {
    // 環境変数があればそれを使用し、なければ一般的なパスを試行
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    // LinuxのSnap版ブラウザ等で発生しやすいサンドボックス制限を回避
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox'],
    slowMo: 500,
  }
});

test.describe('Plower WebGPU Logic Verification', () => {
  const hfToken = process.env.HF_TOKEN;

  test.beforeEach(async ({ page }: { page: Page }) => {
    // 全体タイムアウトを30分に設定
    test.setTimeout(1800000); 
    await page.goto(TEST_URL);
  });

  test('Environment: Reset WebGPU Cache', async ({ page }) => {
    // キャッシュクリアは IndexedDB 等を巡回するため少し時間を取る
    test.setTimeout(120000);
    page.on('dialog', async dialog => {
      if (dialog.type() === 'confirm' || dialog.type() === 'alert') {
        await dialog.accept();
      }
    });
    const clearBtn = page.locator('#clearWebGpuCacheButton');
    await clearBtn.scrollIntoViewIfNeeded();
    await clearBtn.click();
    await page.waitForLoadState('networkidle');
    console.log('WebGPU model cache cleared successfully.');
  });

  test('RAG: File Upload and Automated Context Verification', async ({ page }) => {
    test.slow(); // このテストは時間がかかることを明示
    const fileName = 'rag_test_file.txt';
    const fileContent = 'このドキュメントには「秘密のコード: 9999」が含まれています。';
    
    // ファイルのアップロードを自動化
    await page.setInputFiles('#fileInput', {
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(fileContent)
    });
    await expect(page.locator('#fileListUl')).toContainText(fileName);

    await page.selectOption('#modelSelect', 'webgpu:onnx-community/Qwen2.5-0.5B-Instruct');
    await page.fill('#userInput', '秘密のコードは何？');
    await page.click('#sendButton');

    // 数値の正確性を検証 (Qwen 0.5B のハルシネーション対策済みか)
    const chatLog = page.locator('#chatLog');
    await expect(chatLog).toContainText('9999', { timeout: 1800000 });
    await expect(chatLog).not.toContainText('9998'); 
    console.log('RAG file upload automation passed.');
  });

  test('Reasoning Test: Should detect urgent meeting in 10 minutes (Qwen)', async ({ page }: { page: Page }) => {
    // RAGコンテキスト注入
    const context = "現在 09:50。10:00 会議開始。移動に10分。";
    await page.fill('#pasteArea', context);

    // 軽量モデル選択
    await page.selectOption('#modelSelect', 'webgpu:onnx-community/Qwen2.5-0.5B-Instruct');

    // 推論開始
    await page.fill('#userInput', 'あと10分でどうなりますか？');
    await page.click('#sendButton');

    // 回答に「遅刻」や「間に合わない」という文脈が含まれるか検証
    const chatLog = page.locator('#chatLog');
    await expect(chatLog).toContainText(/(遅刻|間に合わない|すぐに出|出発|急いで|でなくちゃ)/, { timeout: 1500000 });
    console.log('Qwen reasoning test passed.');
  });

  test('GPT-2: Should download and infer without auth dialog', async ({ page }: { page: Page }) => {
    // GPT-2は公開モデルなので認証ダイアログが出ないことを確認
    await page.selectOption('#modelSelect', 'webgpu:onnx-community/gpt2-medium-ONNX');
    await page.fill('#userInput', 'Hello, what is your purpose?');
    await page.click('#sendButton');

    // 認証ダイアログが表示されていないことを確認
    const authDialog = page.locator('h3:has-text("認証が必要です"), h3:has-text("License Required")');
    await expect(authDialog).not.toBeVisible({ timeout: 5000 });

    // モデルがロードされ、何らかの回答が生成されることを確認
    const chatLog = page.locator('#chatLog');
    await expect(chatLog).toContainText(/Hello|AI|language|model/i, { timeout: 60000 });
    console.log('GPT-2 test passed: Downloaded and inferred without auth dialog.');
  });

  test('Llama 3.2: Should show HF Auth Dialog when token is missing', async ({ page }: { page: Page }) => {
    // localStorageからHFトークンをクリア
    await page.evaluate(() => localStorage.removeItem('plowerHfToken'));
    await page.reload({ waitUntil: 'networkidle' }); 

    await page.selectOption('#modelSelect', 'webgpu:onnx-community/Llama-3.2-1B-Instruct');
    await page.fill('#userInput', 'Hello');
    await page.click('#sendButton');

    // 認証ダイアログが表示されるのを待つ (モデルのメタデータ取得等があるため長めに待機)
    const authDialog = page.locator('h3:has-text("認証が必要です"), h3:has-text("License Required")');
    await expect(authDialog).toBeVisible({ timeout: 60000 });

    // ダイアログまでスクロール (Viewportエラー対策)
    await authDialog.scrollIntoViewIfNeeded();

    const tokenInput = page.locator('#authDialogToken');
    await expect(tokenInput).toBeVisible();

    if (hfToken) {
      console.log('Automating Llama 3.2 token entry using environment variable...');
      await tokenInput.fill(hfToken);
      await page.click('#authDialogRetry');
      await expect(authDialog).not.toBeVisible({ timeout: 180000 });
      console.log('Llama 3.2 token entry automation passed.');
    } else {
      console.warn('HF_TOKEN environment variable is not set. Testing manual cancellation.');
      await page.click('#authDialogCancel');
      await expect(authDialog).not.toBeVisible();
    }
  });

  test('Llama 3.2: Reasoning Test (Automated if HF_TOKEN is set)', async ({ page }: { page: Page }) => {
    test.slow();
    if (!hfToken) {
      console.log('Skipping Llama 3.2 Reasoning Test because HF_TOKEN is not set.');
      return;
    }
    // トークンを事前セットしてリロード (ダイアログなしで開始できるか検証)
    await page.evaluate((token) => localStorage.setItem('plowerHfToken', token), hfToken);
    await page.reload({ waitUntil: 'networkidle' });

    const context = "現在 09:50。10:00 会議開始。移動に10分。";
    await page.fill('#pasteArea', context);
    await page.selectOption('#modelSelect', 'webgpu:onnx-community/Llama-3.2-1B-Instruct');
    await page.fill('#userInput', 'あと10分でどうなりますか？');
    await page.click('#sendButton');

    const chatLog = page.locator('#chatLog');
    // Llama 3.2 の巨大さとWASM推論速度を考慮し、20分まで許容
    await expect(chatLog).toContainText(/(遅刻|間に合わない|すぐに出|出発|急いで|でなくちゃ|10:00)/, { timeout: 1200000 });
    console.log('Llama 3.2 automated reasoning test passed.');
  });

  test('Storage Check: Log exists', async ({ page }: { page: Page }) => {
    const logs: string[] = [];
    page.on('console', msg => logs.push(msg.text()));
    await page.reload();
    expect(logs.some(l => l.includes('[Storage]'))).toBeTruthy();
  });
});