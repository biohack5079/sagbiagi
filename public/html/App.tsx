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
  if (url) return url;

  // localhost (dev/preview) の場合は 8080番ポートの Goサーバーを優先
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${host}:8080/ws/chat`;
  } else {
    const workerHost = "sagbi.biohack5079.workers.dev";
    // Workerプロキシは wss が必須なため、プロトコルを wss に固定
    return `wss://${workerHost}/ws/chat`;
  }
};

// 自動ジェスチャーのキーワード設定
const AUTO_GESTURE_RULES = [
  { regex: /踊|ダンス/, action: 'dance' },
  { regex: /回転|まわって|くるくる|twirl/, action: 'twirl' },
  { regex: /すごい|やった|うれしい/, action: 'joy' },
  { regex: /笑|わら|ニコニコ|かわいい/, action: 'smile' },
  { regex: /こんにちは|ハロー|hello|hi/, action: 'wave' },
  { regex: /はい|そうですね|了解/, action: 'nod' },
];

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('sagbi_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [socketStatus, setSocketStatus] = useState<number>(WebSocket.CLOSED);
  const [isOpen, setIsOpen] = useState(() => {
    // URLに ?app=1 があれば最初から開く
    return new URLSearchParams(window.location.search).get('app') === '1';
  });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isCamActive, setIsCamActive] = useState(false);
  const [isChatOverlayActive, setIsChatOverlayActive] = useState(false);
  const [isOverUI, setIsOverUI] = useState(false); // UI要素の上にマウスがあるか
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showChatLog, setShowChatLog] = useState(true);
  const [currentGesture, setCurrentGesture] = useState('reset');
  const triggeredActions = useRef<Set<string>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const messagesRef = useRef<Message[]>([]);

  // スタンドアロンモード（Cloudflare遷移時）の最適化
  useEffect(() => {
    const isStandalone = new URLSearchParams(window.location.search).get('app') === '1';
    if (isStandalone) {
      // 背後の重いHTML要素を削除してボトルネックを排除
      const wrapper = document.getElementById('wrapper');
      if (wrapper) wrapper.style.display = 'none';
      document.body.style.backgroundColor = '#1e1e2f';
      // デフォルトで最大化に近いサイズにする
      setIsMaximized(true);
    }
  }, []);

  // 履歴が変わるたびに保存
  useEffect(() => {
    messagesRef.current = messages;
    // 端末の負担を減らすため、保存も直近100件に絞る
    const clipped = messages.slice(-100);
    localStorage.setItem('sagbi_history', JSON.stringify(clipped));
  }, [messages]);

  // テキスト内のタグ（ジェスチャー・画像）を解析
  const parseContent = useCallback((text: string, msgId: string) => {
    let extractedImage: string | undefined;
    
    // ジェスチャーの抽出: [wave], [ACTION:nod] など
    const gestureRegex = /\[(?:ACTION:)?([a-z_]+)\]/gi;
    let processedText = text.replace(gestureRegex, (_, key) => {
      const gestureKey = key.toLowerCase();
      const triggerKey = `${msgId}-${gestureKey}`;
      if (GESTURES[gestureKey] && !triggeredActions.current.has(triggerKey)) {
        triggeredActions.current.add(triggerKey);
        setCurrentGesture(gestureKey);
        setTimeout(() => setCurrentGesture('reset'), 2000);
      }
      return '';
    });

    // 画像タグの抽出: [IMAGE: url_or_base64]
    const imageRegex = /\[IMAGE:(.+?)\]/gi;
    processedText = processedText.replace(imageRegex, (_, data) => {
      extractedImage = data.trim();
      return '';
    });

    return { text: processedText, image: extractedImage };
  }, []);

  // 文脈から自動的にジェスチャーを推論
  const triggerAutoGesture = useCallback((text: string) => {
    const normalized = text.toLowerCase();
    let action: string | null = null;
    const match = AUTO_GESTURE_RULES.find(rule => rule.regex.test(normalized));
    if (match) action = match.action;

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

  // AppContainerのonPointerDownハンドラ (リサイズ検知用)
  const handleAppContainerPointerDown = (e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 右下30px x 30px の領域をリサイズハンドルと見なす
    const isResizeHandleArea = x > rect.width - 30 && y > rect.height - 30;

    if (isResizeHandleArea) {
      setIsDragging(true);
      const onPointerUp = () => {
        setIsDragging(false);
        window.removeEventListener('pointerup', onPointerUp);
      };
      window.addEventListener('pointerup', onPointerUp);
    }
  };

  // ウィンドウ全体のドラッグ移動処理（ヘッダーと下端ハンドルで使用）
  const handleWindowMove = (e: React.PointerEvent) => {
    // ボタンなどの操作時は無視
    if ((e.target as HTMLElement).closest('button')) return;

    // 3D操作(OrbitControls)への伝播を止める
    e.stopPropagation();

    const container = containerRef.current;
    if (!container) return;

    setIsDragging(true);
    const { clientX, clientY } = e;

    // 移動中はグラブアイコンに変更
    container.style.cursor = 'grabbing';

    let pos3 = clientX;
    let pos4 = clientY;

    const onMove = (moveEvent: PointerEvent) => {
      const currentX = moveEvent.clientX;
      const currentY = moveEvent.clientY;
      
      const pos1 = pos3 - currentX;
      const pos2 = pos4 - currentY;
      pos3 = currentX;
      pos4 = currentY;

      container.style.top = (container.offsetTop - pos2) + "px";
      container.style.left = (container.offsetLeft - pos1) + "px";
      container.style.bottom = 'auto'; 
      container.style.right = 'auto';
    };

    const onEnd = () => {
      container.style.cursor = '';
      setIsDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
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

  // シグナリングメッセージ（SDP/ICE Candidate）の処理
  const handleSignalingMessage = useCallback(async (payload: any) => {
    if (!pcRef.current) return;
    try {
      if (payload.sdp) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        if (payload.sdp.type === 'offer') {
          const answer = await pcRef.current.createAnswer();
          await pcRef.current.setLocalDescription(answer);
          socketRef.current?.send(JSON.stringify({ type: 'signal', payload: { sdp: pcRef.current.localDescription } }));
        }
      } else if (payload.candidate) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
    } catch (e) {
      console.error("[WebRTC] Signaling error:", e);
    }
  }, []);

  // WebRTCセッションの開始と再接続ロジック
  const startWebRTCSession = useCallback(async () => {
    console.log("[WebRTC] Starting session...");

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // DataChannelの設定
    const setupDataChannel = (channel: RTCDataChannel) => {
      channel.onopen = () => console.log("[WebRTC] DataChannel Open (Terminal ready)");
      channel.onmessage = (e) => console.log("[WebRTC] Message from peer:", e.data);
      channel.onclose = () => { dcRef.current = null; };
      dcRef.current = channel;
    };

    // Offer側としてDataChannelを作成
    const dc = pc.createDataChannel("chat");
    setupDataChannel(dc);

    // 相手からDataChannelが来た場合も受け入れる
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'signal', payload: { candidate: event.candidate } }));
      }
    };

    // refer/cnc/app.js を参考にした再接続メカニズム
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[WebRTC State] ${state}`);

      if (state === 'failed' || state === 'disconnected') {
        console.warn("[WebRTC] Connection lost. Attempting to reconnect...");
        setCurrentGesture('thinking'); // 視覚的なフィードバック
        
        // 3秒後に再接続を試行
        setTimeout(() => {
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            startWebRTCSession();
          }
        }, 3000);
      } else if (state === 'connected') {
        setCurrentGesture('reset');
      }
    };

    // トラックの受信設定
    pc.ontrack = (event) => {
      console.log("[WebRTC] Received remote track");
      // 必要に応じてリモートビデオを表示するロジックをここに追加
    };

    pcRef.current = pc;

    // Offerを作成して送信
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current?.send(JSON.stringify({ type: 'signal', payload: { sdp: pc.localDescription } }));
  }, [socketRef]);

  const connectWebSocket = useCallback(() => {
    const url = getSignalingUrl();
    const socket = new WebSocket(url);
    socketRef.current = socket;
    let pingTimeout: any;

    const heartbeat = () => {
      clearTimeout(pingTimeout);
      pingTimeout = setTimeout(() => {
        console.warn("[WebSocket] Heartbeat timeout. Closing...");
        socket.close();
      }, 45000); // サーバーのPing送信間隔(30s)より少し長く設定
    };

    setSocketStatus(WebSocket.CONNECTING);

    socket.onopen = () => {
      console.log("[WebSocket] Connection established. Registering...");
      heartbeat();
      // 接続時にローカルの履歴をサーバーに送り、同期を図る
      socket.send(JSON.stringify({ 
        type: 'register', 
        payload: { role: 'user', history: messagesRef.current } 
      }));
      setSocketStatus(WebSocket.OPEN);
      startWebRTCSession();
    };

    socket.onmessage = (event) => {
      heartbeat();
      const data = JSON.parse(event.data);
      console.log("[WebSocket] Received:", data); // デバッグ用ログを追加
      const { type, payload, from, history } = data;

      if (type === 'history' && history) {
        // サーバーから送られてきた履歴でローカルを更新（型変換）
        const formatted = history.map((h: any) => ({
          id: h.id,
          text: h.text,
          isUser: h.isUser,
          senderName: h.senderName || (h.isUser ? 'You' : 'SAGBI AI'),
          image: h.image,
          done: h.done
        }));

        setMessages((prev) => {
          const existingIds = new Set(prev.map(m => m.id));
          const newOnes = formatted.filter((m: Message) => !existingIds.has(m.id));
          if (newOnes.length === 0) return prev;
          
          // 既存のものと合体させ、直近100件を保持
          return [...prev, ...newOnes].slice(-100);
        });
      } else if (type === 'chat_response' || type === 'chat_message') {
        const isAi = type === 'chat_response';
        const msgId = payload.id || (isAi ? 'ai-current' : 'user-current');
        const rawText = payload.text;

        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === msgId);
          const { text, image: parsedImage } = rawText !== undefined 
            ? parseContent(rawText, msgId) 
            : { text: undefined, image: undefined };

          if (existingIndex !== -1) {
            const updated = [...prev];
            if (text !== undefined) updated[existingIndex].text = text;
            if (parsedImage) updated[existingIndex].image = parsedImage;
            updated[existingIndex].done = !!payload.done;
            return updated;
          }
          return [...prev, { 
            id: msgId, 
            text: text || (isAi ? '...' : ''), 
            isUser: !isAi, 
            senderName: from || (isAi ? 'sagbiちゃん' : 'You'), 
            image: payload.image || parsedImage, 
            done: !!payload.done 
          }];
        });

        if (isAi) {
          setIsTalking(!payload.done);
          if (payload.done) triggerAutoGesture(rawText);
        }
      } else if (type === 'signal') {
        // WebRTCシグナリングの処理 (Offer/Answer/Candidate)
        handleSignalingMessage(payload);
      }
    };

    socket.onclose = () => {
      clearTimeout(pingTimeout);
      console.warn("[WebSocket] Disconnected. Reconnecting in 2s...");
      setSocketStatus(WebSocket.CLOSED);
      // PCの休止復帰時などを考慮し、早めに再接続を試みる
      setTimeout(connectWebSocket, 2000);
    };

    socket.onerror = (err) => {
      console.error("[WebSocket] Error:", err);
      setSocketStatus(WebSocket.CLOSED);
    };
  }, [parseContent, triggerAutoGesture, startWebRTCSession]);

  useEffect(() => {
    connectWebSocket();
    return () => socketRef.current?.close();
  }, [connectWebSocket]);

  useEffect(() => {
    // メッセージ更新時、またはチャット画面が開かれた時に最新メッセージ（最下部）へスクロール
    // Scroll to the bottom to show the latest message on update or when the chat screen is opened
    if (isOpen && showChatLog) {
      const timer = setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages, isOpen, showChatLog]);

  const sendMessage = (text: string) => {
    if (!text.trim() && !previewImage) return;

    // 送信時に接続が切れていれば再接続を試みる
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      return;
    }

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


    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(text.trim());
    }

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
      onPointerDown={handleAppContainerPointerDown}
    >
      <div 
        className="chat-header" 
        onDoubleClick={handleDoubleClick}
        onPointerDown={handleWindowMove}
        onPointerEnter={() => setIsOverUI(true)}
        onPointerLeave={() => setIsOverUI(false)}
      >
        <div className="chat-status-area">
          <button 
            className="chat-btn" 
            onClick={(e) => { e.stopPropagation(); setShowChatLog(!showChatLog); }} 
            title={showChatLog ? "コメントを非表示" : "コメントを表示"}
            style={{ fontSize: '18px', marginRight: '4px' }}
          >
            {showChatLog ? '👁️' : '🙈'}
          </button>
          <div className={`chat-status-dot ${socketStatus === WebSocket.OPEN ? 'online' : ''}`}></div>
          <span className="chat-title">SAGBI AGI</span>
        </div>
        <div className="chat-controls">
          <button className="chat-btn" onClick={() => {
            setMessages([]);
            localStorage.removeItem('sagbi_history');
          }} title="表示をクリア">
            🗑️
          </button>
          <button className="chat-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
            {isCollapsed ? '+' : '−'}
          </button>
        </div>
      </div>

      <div className="canvas-wrapper">
        {/* SuspenseをCanvasの外に出し、Loading表示を追加 */}
        <Suspense fallback={<div style={{color: 'white', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)'}}>Loading Agent...</div>}>
          <Canvas shadows eventSource={containerRef as any}>
              <PerspectiveCamera makeDefault position={[0, 1.2, 4.0]} fov={45} />
              <OrbitControls
                target={[0, 0.9, 0]}
                enableDamping
                // ドラッグ中、またはUI要素（吹き出し等）の上にポインタがある時は3D操作を無効化
                enabled={!isDragging && !isOverUI}
              />
              <ambientLight intensity={0.8} />
              <directionalLight position={[1, 2, 1]} intensity={1.2} />
              <gridHelper args={[10, 20, 0x888888, 0x444444]} />
              <AgentModel modelPath={agentModelUrl} isTalking={isTalking} currentGesture={currentGesture} />
          </Canvas>
        </Suspense>
      </div>

      <div 
        className="chat-overlay"
        onPointerEnter={() => {}} // 以前の coarse な判定は削除
      >
        <div 
          className="chat-log"
          style={{ display: showChatLog ? 'flex' : 'none' }}
          data-testid="chat-log" // テスト用にdata-testidを追加
          onWheel={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            // RTL設定時、スクロールバーは左側(0px付近)にある
            const isScrollbarArea = x < 30;
            if (e.target !== e.currentTarget || isScrollbarArea) {
              e.stopPropagation();
            }
          }}
        >
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.isUser ? 'user' : 'ai'}`}>
              <div 
                className="bubble" 
                // 吹き出しの上では3D操作を無効にする
                onPointerEnter={() => setIsOverUI(true)}
                onPointerLeave={() => setIsOverUI(false)}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              >
                <div className="sender">{m.senderName}</div>
                {m.image && (
                  <img 
                    src={m.image.startsWith('data:') || m.image.startsWith('http') ? m.image : `data:image/jpeg;base64,${m.image}`} 
                    alt="attached" 
                    className="bubble-img" 
                  />
                )}
                <div className="text">
                  {m.text}
                  {!m.done && !m.isUser && <span className="thinking-dots">...</span>}
                </div>
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        <div 
          className="input-area" 
          onPointerDown={e => e.stopPropagation()} 
          onMouseDown={e => e.stopPropagation()}
          onPointerEnter={() => setIsOverUI(true)}
          onPointerLeave={() => setIsOverUI(false)}
        >
          {/* 下端の移動用ハンドル */}
          <div className="drag-handle-bottom" onPointerDown={handleWindowMove} />
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