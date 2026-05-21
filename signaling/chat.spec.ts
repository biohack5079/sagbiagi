import { test, expect } from '@playwright/test';

test('エージェントに踊るように頼むと反応すること', async ({ page }) => {
  await page.goto('http://localhost:5173'); // Viteのデフォルトポート

  // チャット入力
  const input = page.locator('#chat-input');
  await input.fill('くるくる回って踊って！');
  await page.click('#chat-send-btn');

  // 自分のメッセージが表示されるか
  await expect(page.locator('.message.user')).toContainText('くるくる回って踊って！');

  // AIの応答を待つ (Ollamaの起動状況によりタイムアウト調整が必要)
  const aiBubble = page.locator('.message.ai .bubble').first();
  await expect(aiBubble).toBeVisible({ timeout: 30000 });

  // 3Dモデルの Canvas が存在するか
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  
  // スクリーンショットを撮って動きを目視確認することも可能
  await page.screenshot({ path: 'test-results/dance-reaction.png' });
});