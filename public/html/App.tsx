import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { AgentModel } from './AgentModel';
import { GESTURES, Message } from './agent';
import agentModelUrl from './agent.glb?url'; // モデルのURLをインポート
import './App.css';

const getSignalingUrl = () => {
  const urlParams = new URLSearchParams(window.location.search);
  let url = urlParams.get('s');
  if (!url) {
    const workerHost = "sagbi.biohack5079.workers.dev";
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${protocol}//${workerHost}/ws/chat`;
  }
  return url;
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isCamActive, setIsCamActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [currentGesture, setCurrentGesture] = useState('reset');
  const triggeredActions = useRef<Set<string>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // [wave] 等のタグを解析してジェスチャーを発動
  const parseGestures = useCallback((text: string, msgId: string) => {
    const regex = /\[(?:ACTION:)?([a-z_]+)\]/gi;
    const plainText = text.replace(regex, (_, key) => {
      const gestureKey = key.toLowerCase();
      const triggerKey = `${msgId}-${gestureKey}`;

      if (GESTURES[gestureKey] && !triggeredActions.current.has(triggerKey)) {
        triggeredActions.current.add(triggerKey);
        setCurrentGesture(gestureKey);
        setTimeout(() => setCurrentGesture('reset'), 2000);
      }
      return '';
    });
    return plainText;
  }, []);

  // 文脈から自動的にジェスチャーを推論
  const triggerAutoGesture = useCallback((text: string) => {
    const normalized = text.toLowerCase();
    let action: string | null = null;
    if (/こんにちは|ハロー|hello|hi/.test(normalized)) action = 'wave';
    else if (/はい|そうですね|了解/.test(normalized)) action = 'nod';
    else if (/すごい|やった|うれしい/.test(normalized)) action = 'joy';
    else if (/踊|ダンス/.test(normalized)) action = 'dance';

    if (action) {
      setCurrentGesture(action);
      setTimeout(() => setCurrentGesture('reset'), 2000);
    }
  }, []);

  // index.html のボタンから呼び出せるようにグローバルに公開
  useEffect(() => {
    (window as any).toggleSagbiChat = () => setIsOpen(prev => !prev);
  }, []);

  // ヘッダーダブルクリックでの最大化切り替え
  const handleDoubleClick = () => {
    setIsMaximized(!isMaximized);
  };

  // マウスドラッグ移動のロジック
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.chat-btn')) return;
    
    const container = containerRef.current;
    if (!container) return;

    e.preventDefault();
    let pos3 = e.clientX;
    let pos4 = e.clientY;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos1 = pos3 - moveEvent.clientX;
      const pos2 = pos4 - moveEvent.clientY;
      pos3 = moveEvent.clientX;
      pos4 = moveEvent.clientY;

      container.style.top = (container.offsetTop - pos2) + "px";
      container.style.left = (container.offsetLeft - pos1) + "px";
      container.style.bottom = 'auto'; 
      container.style.right = 'auto';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  useEffect(() => {
    const url = getSignalingUrl();
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const { type, payload, from } = JSON.parse(event.data);
      if (type === 'chat_response' || type === 'chat_message') {
        const isAi = type === 'chat_response';
        const msgId = payload.id;
        const rawText = payload.text || '';

        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === msgId);
          const text = parseGestures(rawText, msgId);
          if (existingIndex !== -1) {
            const updated = [...prev];
            updated[existingIndex] = { ...updated[existingIndex], text, done: payload.done };
            return updated;
          }
          return [...prev, { id: msgId, text, isUser: !isAi, senderName: from || (isAi ? 'sagbi' : 'You'), done: payload.done }];
        });

        if (isAi) {
          setIsTalking(!payload.done);
          if (payload.done) triggerAutoGesture(rawText);
        }
      }
    };
    return () => socket.close();
  }, [parseGestures, triggerAutoGesture]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isOpen) return null;

  const sendMessage = (text: string) => {
    if ((!text.trim() && !previewImage) || !socketRef.current) return;
    socketRef.current.send(JSON.stringify({ type: 'chat_message', payload: { text: text.trim() } }));
  };

  return (
    <div ref={containerRef} className={`app-container ${isCollapsed ? 'collapsed' : ''} ${isMaximized ? 'maximized' : ''}`} style={{ display: isOpen ? 'flex' : 'none' }}>
      <div className="chat-header" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick}>
        <div className="chat-status-area">
          <div className={`chat-status-dot ${socketRef.current?.readyState === 1 ? 'online' : ''}`}></div>
          <span className="chat-title">SAGBI AGI</span>
        </div>
        <div className="chat-controls">
          <button className="chat-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
            {isCollapsed ? '+' : '−'}
          </button>
        </div>
      </div>

      <div className="canvas-wrapper">
        {/* SuspenseをCanvasの外に出し、Loading表示を追加 */}
        <Suspense fallback={<div style={{color: 'white', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)'}}>Loading Agent...</div>}>
          <Canvas shadows>
              <PerspectiveCamera makeDefault position={[0, 1.2, 4.0]} fov={45} />
              <OrbitControls target={[0, 0.9, 0]} enableDamping />
              <ambientLight intensity={0.8} />
              <directionalLight position={[1, 2, 1]} intensity={1.2} />
              <gridHelper args={[10, 20, 0x888888, 0x444444]} />
              <AgentModel modelPath={agentModelUrl} isTalking={isTalking} currentGesture={currentGesture} />
          </Canvas>
        </Suspense>
      </div>

      <div className="chat-overlay">
        <div className="chat-log">
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.isUser ? 'user' : 'ai'}`}>
              <div className="bubble">
                <div className="sender">{m.senderName}</div>
                <div className="text">{m.text}</div>
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        <div className="input-area">
          {previewImage && (
            <div className="image-preview-container">
              <img src={previewImage} alt="preview" />
              <button className="remove-btn" onClick={() => setPreviewImage(null)}>×</button>
            </div>
          )}
          <div className="media-controls">
            <button 
              className={`media-btn ${isCamActive ? 'active' : ''}`} 
              onClick={() => setIsCamActive(!isCamActive)} title="Camera">📷</button>
            <button 
              className={`media-btn ${isMicActive ? 'active' : ''}`} 
              onClick={() => setIsMicActive(!isMicActive)} title="Microphone">🎤</button>
            <button className="media-btn" onClick={() => document.getElementById('file-upload')?.click()} title="Attach Image">📎</button>
            <input type="file" id="file-upload" style={{display: 'none'}} accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => setPreviewImage(ev.target?.result as string);
                reader.readAsDataURL(file);
              }
            }} />
          </div>
          <div style={{display:'flex', gap:'8px', alignItems:'flex-end'}}>
            <textarea 
              id="chat-input"
              placeholder="聞きたいことを入力..." 
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(e.currentTarget.value);
                  e.currentTarget.value = '';
                }
              }}
            ></textarea>
            <button id="chat-send-btn" onClick={() => {
              const input = document.getElementById('chat-input') as HTMLTextAreaElement;
              sendMessage(input.value);
              input.value = '';
            }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
export default App;