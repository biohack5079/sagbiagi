import { WebSocket } from 'ws';

// シグナリングサーバーのURL（Goサーバーのアドレスに合わせてください）
const SIGNALING_SERVER = 'ws://localhost:8080/ws/chat'; // ブラウザのgetSignalingUrl()と合わせる

const ws = new WebSocket(SIGNALING_SERVER);

ws.on('open', () => {
  console.log('\x1b[36m%s\x1b[0m', '--- Terminal Chat Monitor Connected ---');
  // ターミナル用クライアントとして登録
  ws.send(JSON.stringify({ type: 'register', payload: { role: 'terminal' } }));
});

// メッセージをターミナルに整形して表示するヘルパー
const displayMessage = (sender, text, isUser, hasImage) => {
  const color = isUser ? '\x1b[32m' : '\x1b[35m'; // User=緑, AI=紫
  // [ACTION:...] などのタグを除去
  const cleanText = text ? text.replace(/\[(?:ACTION:)?([a-z_]+)\]/gi, '').trim() : '';
  
  if (cleanText || hasImage) {
    process.stdout.write(`${color}[${sender}]:\x1b[0m ${cleanText}`);
    if (hasImage) {
      process.stdout.write(` \x1b[90m(📷 画像あり)\x1b[0m`);
    }
    process.stdout.write('\n');
  }
};

ws.on('message', async (data) => {
  try {
    const msg = JSON.parse(data);

    // 1. 接続直後に送られてくる過去の履歴を処理
    if (msg.type === 'history' && msg.history) {
      console.log('\x1b[33m%s\x1b[0m', '--- 過去の会話履歴を同期中 ---');
      msg.history.forEach(item => {
        const sender = item.isUser ? 'You' : (item.senderName || 'SAGBI AI');
        displayMessage(sender, item.text, item.isUser, !!item.image);
      });
      console.log('\x1b[33m%s\x1b[0m', '--- 同期完了。新しいメッセージを待機中 ---');
      return;
    }
    
    // 2. リアルタイムメッセージの処理
    const isUser = msg.type === 'chat_message';
    const isAiDone = msg.type === 'chat_response' && msg.payload?.done;

    if ((isUser || isAiDone) && (msg.payload?.text || msg.payload?.image)) {
      const isAi = msg.type === 'chat_response';
      const sender = isAi ? (msg.from || 'sagbiちゃん') : 'You';
      displayMessage(
        sender, 
        msg.payload.text, 
        !isAi, 
        !!msg.payload.image
      );
    }
  } catch (e) {
    console.error('Error handling message:', e);
  }
});

console.log('Terminal Monitor started. Monitoring messages via WebSocket...');
