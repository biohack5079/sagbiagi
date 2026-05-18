import { WebSocket } from 'ws';

// シグナリングサーバーのURL（Goサーバーのアドレスに合わせてください）
const SIGNALING_SERVER = 'ws://localhost:8080/ws/chat'; // ブラウザのgetSignalingUrl()と合わせる

const ws = new WebSocket(SIGNALING_SERVER);

ws.on('open', () => {
  console.log('\x1b[36m%s\x1b[0m', '--- Terminal Chat Monitor Connected ---');
  // ターミナル用クライアントとして登録
  ws.send(JSON.stringify({ type: 'register', payload: { role: 'terminal' } }));
});

ws.on('message', async (data) => {
  try {
    const msg = JSON.parse(data);
    
    // ユーザーのメッセージ、またはAIの返答が完了(done)した時だけ表示する
    const isUser = msg.type === 'chat_message';
    const isAiDone = msg.type === 'chat_response' && msg.payload?.done;

    if ((isUser || isAiDone) && msg.payload?.text) {
      const isAi = msg.type === 'chat_response';
      const sender = isAi ? (msg.from || 'sagbiちゃん') : 'You';
      const color = isAi ? '\x1b[35m' : '\x1b[32m'; // AIは紫、Userは緑
      
      // [ACTION:...] などのタグを除去して表示
      const cleanText = msg.payload.text.replace(/\[(?:ACTION:)?([a-z_]+)\]/gi, '').trim();
      
      if (cleanText) {
        console.log(`${color}[${sender}]:\x1b[0m ${cleanText}`);
      }
    }
  } catch (e) {
    console.error('Error handling message:', e);
  }
});

console.log('Terminal Monitor started. Monitoring messages via WebSocket...');
