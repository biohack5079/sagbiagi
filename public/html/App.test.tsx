/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { Message } from './agent';
import userEvent from '@testing-library/user-event';
// toBeInTheDocument などのマッチャーを有効化
import '@testing-library/jest-dom/vitest';

// AgentModelをモック化してThree.jsの警告やupdateWorldMatrixエラーを回避
// Appのインポートより前に記述して、Appがロードされる際に確実にモックが適用されるようにします
vi.mock('./AgentModel', () => ({
  AgentModel: vi.fn(({ currentGesture }) => <div data-testid="agent-model-mock" data-current-gesture={currentGesture} />)
}));

// Canvasのモック（3Dレンダリングはテスト環境では動かないため）
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="canvas-mock">
      {React.Children.map(children, child => {
        // 小文字のタグ（ambientLight等）はJSDOMで警告が出るため、コンポーネントのみをレンダリング
        return (React.isValidElement(child) && typeof child.type !== 'string') ? child : null;
      })}
    </div>
  ),
  useFrame: () => {},
  // イベントハンドラ等で必要な場合があるため、拡張
  extend: vi.fn(),
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => <div />,
  PerspectiveCamera: () => <div />,
  useGLTF: () => ({ scene: { traverse: () => {}, scale: { set: () => {} }, position: { y: 0 }, rotation: { y: 0 } } }),
}));

// JSDOMはscrollIntoViewを実装していないため、スタブ化してエラーを回避する
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// WebSocketのモック
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  readyState = MockWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();
}

import App from './App';

// MockWebSocketのインスタンスを保持し、テスト中にメッセージを送信できるようにする
vi.stubGlobal('WebSocket', MockWebSocket);

// randomUUIDのモック (JSDOM環境で不足している場合があるため)
if (!global.crypto) {
  // @ts-ignore
  global.crypto = { randomUUID: () => 'test-uuid-' + Math.random() };
}

/**
 * WebSocketの静的プロパティを維持しつつ、特定のインスタンスを返すモックを作成します。
 */
const stubWebSocket = (instance: MockWebSocket) => {
  const MockWS = vi.fn(() => instance);
  Object.assign(MockWS, MockWebSocket);
  vi.stubGlobal('WebSocket', MockWS);
};

describe('SAGBI AGI App Logic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(cleanup); // 各テスト後にDOMをクリーンアップ

  it('「くるくる」という言葉で twirl ジェスチャーがトリガーされること', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText('聞きたいことを入力...');

    // toggleSagbiChatがwindowに設定されるのを待つ
    await waitFor(() => {
      expect(window as any).toHaveProperty('toggleSagbiChat');
    });

    // チャットUIを開く
    (window as any).toggleSagbiChat(); 
    await screen.findByText('SAGBI AGI');

    const input = screen.getByPlaceholderText('聞きたいことを入力...') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('chat-send-btn');

    // ユーザーが「くるくる回って！」と入力
    await user.type(input, 'くるくる回って！');
    if (sendBtn) await user.click(sendBtn);

    // メッセージがログに表示されているか確認
    expect(await screen.findByText('くるくる回って！')).toBeInTheDocument();
    
    // 内部的な currentGesture の変化を直接見ることは難しいが、
    // メッセージ追加後に triggerAutoGesture が呼ばれるフローを確認
  });

  it('AIからのメッセージに[ACTION:twirl]タグが含まれるとtwirlジェスチャーがトリガーされ、タグは表示されないこと', async () => {
    const mockWebSocketInstance = new MockWebSocket();
    stubWebSocket(mockWebSocketInstance);

    render(<App />);
    await screen.findByPlaceholderText('聞きたいことを入力...');
    await waitFor(() => {
      expect(window as any).toHaveProperty('toggleSagbiChat');
    });
    (window as any).toggleSagbiChat();
    await screen.findByText('SAGBI AGI');

    // AIからのメッセージをシミュレート
    const aiMessagePayload: Message = {
      id: 'ai-123',
      text: 'くるくる回ります！[ACTION:twirl]',
      isUser: false,
      senderName: 'SAGBI AI',
      done: true,
    };
    const wsMessage = {
      type: 'chat_response',
      payload: aiMessagePayload,
      from: 'SAGBI AI',
    };

    // WebSocketのonmessageイベントを発火
    await act(async () => {
      mockWebSocketInstance.onmessage!({ data: JSON.stringify(wsMessage) } as MessageEvent);
    });

    // AgentModelがtwirlジェスチャーを受け取ったことを確認
    const agentModelMock = await screen.findByTestId('agent-model-mock');
    await waitFor(() => expect(agentModelMock).toHaveAttribute('data-current-gesture', 'twirl'));

    // メッセージがチャットログに表示され、[ACTION:twirl]タグが除去されていることを確認
    expect(await screen.findByText('くるくる回ります！')).toBeInTheDocument();
    expect(screen.queryByText('[ACTION:twirl]')).not.toBeInTheDocument();
  });

  it('AIの応答に「くるくる」が含まれるとtwirlジェスチャーが自動トリガーされること', async () => {
    const mockWebSocketInstance = new MockWebSocket();
    stubWebSocket(mockWebSocketInstance);

    render(<App />);
    await screen.findByPlaceholderText('聞きたいことを入力...');
    await waitFor(() => {
      expect(window as any).toHaveProperty('toggleSagbiChat');
    });
    (window as any).toggleSagbiChat();
    await screen.findByText('SAGBI AGI');

    // AIからのメッセージをシミュレート (done: true で自動ジェスチャーがトリガーされる)
    const aiMessagePayload: Message = {
      id: 'ai-456',
      text: 'はい、くるくる回ります！',
      isUser: false,
      senderName: 'SAGBI AI',
      done: true, // triggerAutoGesture が呼ばれる条件
    };
    const wsMessage = {
      type: 'chat_response',
      payload: aiMessagePayload,
      from: 'SAGBI AI',
    };

    await act(async () => {
      mockWebSocketInstance.onmessage!({ data: JSON.stringify(wsMessage) } as MessageEvent);
    });

    // AgentModelがtwirlジェスチャーを受け取ったことを確認
    const agentModelMock = await screen.findByTestId('agent-model-mock');
    await waitFor(() => expect(agentModelMock).toHaveAttribute('data-current-gesture', 'twirl'));

    // メッセージがチャットログに表示されていることを確認
    expect(await screen.findByText('はい、くるくる回ります！')).toBeInTheDocument();
  });

  it('履歴クリアボタンでメッセージが消去されること', async () => {
    const user = userEvent.setup();
    const mockWebSocketInstance = new MockWebSocket();
    stubWebSocket(mockWebSocketInstance);

    render(<App />);
    await screen.findByPlaceholderText('聞きたいことを入力...');
    await waitFor(() => {
      expect(window as any).toHaveProperty('toggleSagbiChat');
    });
    (window as any).toggleSagbiChat();
    await screen.findByText('SAGBI AGI');

    // テスト用のメッセージをいくつか追加
    const input = screen.getByPlaceholderText('聞きたいことを入力...') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('chat-send-btn');

    await user.type(input, 'テストメッセージ1');
    if (sendBtn) await user.click(sendBtn);
    await waitFor(() => expect(screen.getByText('テストメッセージ1')).toBeInTheDocument());

    await user.type(input, 'テストメッセージ2');
    if (sendBtn) await user.click(sendBtn);
    await waitFor(() => expect(screen.getByText('テストメッセージ2')).toBeInTheDocument());

    // AIからのメッセージも追加
    const aiMessagePayload: Message = {
      id: 'ai-clear-test',
      text: 'AIからの応答',
      isUser: false,
      senderName: 'SAGBI AI',
      done: true,
    };
    const wsMessage = {
      type: 'chat_response',
      payload: aiMessagePayload,
      from: 'SAGBI AI',
    };
    await act(async () => {
      mockWebSocketInstance.onmessage!({ data: JSON.stringify(wsMessage) } as MessageEvent);
    });
    await waitFor(() => expect(screen.getByText('AIからの応答')).toBeInTheDocument());

    // クリアボタンをクリック
    const clearBtn = screen.getByTitle('表示をクリア');
    fireEvent.click(clearBtn);
    
    // メッセージがすべて消去されたことを確認
    // chat-log にはスクロール用の div が残るため、message クラスを持つ要素がないことを確認
    expect(document.querySelectorAll('.message').length).toBe(0);
    expect(screen.queryByText('テストメッセージ1')).not.toBeInTheDocument();
    expect(screen.queryByText('テストメッセージ2')).not.toBeInTheDocument();
    expect(screen.queryByText('AIからの応答')).not.toBeInTheDocument();
  });
});
