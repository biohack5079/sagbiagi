import { WebSocket } from 'ws';

// シグナリングサーバーのURL（Goサーバーのアドレスに合わせてください）
const SIGNALING_SERVER = 'ws://127.0.0.1:8080/ws/chat'; // localhostより127.0.0.1の方が安定する

function connect() {
  const ws = new WebSocket(SIGNALING_SERVER);
  let pingTimeout;

  function heartbeat() {
    clearTimeout(pingTimeout);
    // サーバーからのPingが途絶えて40秒経過したら「死んでいる」とみなして切断
    pingTimeout = setTimeout(() => {
      console.warn('\x1b[33m%s\x1b[0m', '[Warning] Heartbeat timeout. Reconnecting...');
      ws.terminate();
    }, 40000);
  }

  ws.on('open', () => {
    console.log('\x1b[36m%s\x1b[0m', '--- Terminal Chat Monitor Connected ---');
    heartbeat();
    // ターミナル用クライアントとして登録
    ws.send(JSON.stringify({ type: 'register', payload: { role: 'terminal' } }));
  });

  ws.on('ping', heartbeat);

// メッセージをターミナルに整形して表示するヘルパー
const displayMessage = (sender, text, isUser, hasImage) => {
  const color = isUser ? '\x1b[32m' : '\x1b[35m'; // User=緑, AI=紫
  // [ACTION:...] などのタグを除去
  const cleanText = text ? text.replace(/\[(?:ACTION:)?([a-z_]+)\]/gi, '').trim() : '';
  
  if (cleanText || hasImage) {
    let output = `${color}[${sender}]:\x1b[0m ${cleanText}`;
    if (hasImage) output += ` \x1b[90m(📷 画像あり)\x1b[0m`;
    console.log(output); // process.stdout.write より確実に出力される console.log を使用
  }
};

ws.on('message', async (data) => {
  try {
    heartbeat();
    const msg = JSON.parse(data.toString());

    // 1. 接続直後に送られてくる過去の履歴を処理
    if (msg.type === 'history' && msg.history) {
      msg.history.forEach(item => {
        displayMessage(item.senderName || (item.isUser ? 'You' : 'SAGBI AI'), item.text, item.isUser, !!item.image);
      });
      return;
    }
    
    // 2. リアルタイムメッセージの処理
    const isUserMessage = (msg.type === 'chat_message');
    const isAiResponse = (msg.type === 'chat_response');
    
    let payload = msg.payload;
    if (typeof payload === 'string' && payload.trim().startsWith('{')) {
      try { payload = JSON.parse(payload); } catch (e) {}
    }

    const hasContent = payload?.text || payload?.image;

    // AI回答の場合、確定(done)するまでは表示をスキップ（ターミナルの重複防止）
    if (isAiResponse && payload && payload.done === false) return;

    if ((isUserMessage || isAiResponse) && hasContent) {
      const sender = isAiResponse ? (msg.from || payload.senderName || 'SAGBI AI') : 'You';
      displayMessage(
        sender, 
        payload.text, 
        isUserMessage, // isUserMessageがtrueならユーザー、falseならAI
        !!payload.image
      );
    }
  } catch (e) {
    console.error('Error handling message:', e);
  }
});

  ws.on('close', () => {
    clearTimeout(pingTimeout);
    console.log('\x1b[31m%s\x1b[0m', '[System] Connection lost. Retrying in 3s...');
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('[Error] WebSocket error:', err.message);
  });
}

connect();
console.log('Terminal Monitor started. Monitoring messages via WebSocket...');
