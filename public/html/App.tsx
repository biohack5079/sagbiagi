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
    // Workerプロキシは wss が必須なため、プロトコルを wss に固定
    url = `wss://${workerHost}/ws/chat`;
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);

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

  // クリップボードからの貼り付け（スクリーンショット等）の処理
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => setPreviewImage(ev.target?.result as string);
            reader.readAsDataURL(file);
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  // カメラの切り替え（背面カメラ優先）
  const toggleCamera = useCallback(async () => {
    if (isCamActive) {
      stream?.getTracks().forEach(track => track.stop());
      setStream(null);
      setIsCamActive(false);
    } else {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        setStream(newStream);
        if (videoRef.current) videoRef.current.srcObject = newStream;
        setIsCamActive(true);
      } catch (err) {
        console.error("Camera access failed:", err);
      }
    }
  }, [isCamActive, stream]);

  // ヘッダーダブルクリックでの最大化切り替え
  const handleDoubleClick = () => {
    setIsMaximized(!isMaximized);
  };

  // フレーム全体でのマウスドラッグ移動
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // 1. インタラクティブな要素は除外
    if (target.closest('button') || target.closest('input') || target.closest('textarea') ||
      target.closest('.media-controls') || target.tagName === 'CANVAS' || target.closest('.bubble')) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      // 右下の角（リサイズハンドル付近 50px）をクリックした時はドラッグ移動を無効にする
      const isNearEdgeX = e.clientX > rect.right - 50;
      const isNearEdgeY = e.clientY > rect.bottom - 50;
      if (isNearEdgeX && isNearEdgeY) return;
    }
    
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

  // マイク制御 (SpeechRecognition)
  const toggleMic = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("このブラウザは音声認識をサポートしていません。");
      return;
    }

    if (isMicActive) {
      recognitionRef.current?.stop();
      setIsMicActive(false);
    } else {
      const recognition = new SpeechRecognition();
      recognition.lang = 'ja-JP';
      recognition.continuous = false;
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        const input = document.getElementById('chat-input') as HTMLTextAreaElement;
        if (input) input.value += transcript;
      };
      recognition.onend = () => setIsMicActive(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsMicActive(true);
    }
  }, [isMicActive]);

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
            updated[existingIndex].text = text; // 累積テキストで更新
            updated[existingIndex].done = payload.done;
            return updated;
          }
          return [...prev, { id: msgId, text: text || '', isUser: !isAi, senderName: from || (isAi ? 'sagbi' : 'You'), image: payload.image, done: payload.done }];
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

  const sendMessage = (text: string) => {
    if ((!text.trim() && !previewImage) || !socketRef.current) return;

    const tempId = "user-" + crypto.randomUUID();

    // ユーザーのメッセージを即座にローカル表示に追加 (chat.jsのロジックを踏襲)
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        text: text.trim(),
        isUser: true,
        senderName: 'You',
        image: previewImage || undefined,
        done: true
      }
    ]);

    socketRef.current.send(JSON.stringify({
      type: 'chat_message',
      payload: {
        text: text.trim(),
        image: previewImage?.split(',')[1],
        id: tempId
      }
    }));

    setPreviewImage(null);
  };

  return (
    <div 
      ref={containerRef} 
      className={`app-container ${isCollapsed ? 'collapsed' : ''} ${isMaximized ? 'maximized' : ''}`} 
      style={{ display: isOpen ? 'flex' : 'none' }}
      onMouseDown={handleMouseDown}
    >
      <div className="chat-header" onDoubleClick={handleDoubleClick}>
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
                {m.image && <img src={m.image.startsWith('data:') ? m.image : `data:image/jpeg;base64,${m.image}`} alt="attached" className="bubble-img" />}
                <div className="text">
                  {m.text}
                  {!m.done && !m.isUser && <span className="thinking-dots">...</span>}
                </div>
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
          {isCamActive && (
            <div className="camera-preview-container">
              <video ref={videoRef} autoPlay playsInline muted />
            </div>
          )}
          <div className="media-controls">
            <button className={`media-btn ${isCamActive ? 'active' : ''}`} onClick={toggleCamera} title="Camera">📷</button>

            <button className={`media-btn ${isMicActive ? 'active' : ''}`} onClick={toggleMic} title="Microphone">🎤</button>
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
          <div className="input-row-flex">
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
    </div >
  );
};
export default App;