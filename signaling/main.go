// SAGBI AGI — Go Signaling + Chat Relay Server
// WebSocket signaling for distributed AI agent communication.
// Routes chat messages to the local Ollama instance and returns responses.

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// RAGキャッシュ用
var (
	ragCache     string
	lastRagCheck time.Time
	ragMu        sync.RWMutex
)

// サーバー側で保持する履歴の永続化用
var (
	globalHistory []ChatPayload
	historyMu     sync.Mutex
	persistFile   = "history_state.json"
)

// ── Configuration ────────────────────────────────────────────
var (
	listenAddr  = envOr("LISTEN_ADDR", ":8080")
	ollamaURL   = envOr("OLLAMA_URL", "http://localhost:11434")
	ollamaModel = envOr("OLLAMA_MODEL", "gemma3:4b-it-q4_K_M")
	// RAG_DIR 環境変数を参照。設定されていなければRAG機能はデフォルトで無効。
	ragSourceDir = envOr("RAG_DIR", "")
	// HISTORY_DIR 環境変数を参照。設定されていなければ履歴保存は無効。
	historyDir = envOr("HISTORY_DIR", "")
	// SYSTEM_PROMPT_DIR システムプロンプトファイルのディレクトリ
	systemPromptDir = envOr("SYSTEM_PROMPT_DIR", "../public/html")
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// 履歴をファイルに保存
func saveHistory() {
	historyMu.Lock()
	defer historyMu.Unlock()
	data, _ := json.Marshal(globalHistory)
	_ = os.WriteFile(persistFile, data, 0644)
}

// 履歴をファイルから読み込み
func loadHistory() {
	historyMu.Lock()
	defer historyMu.Unlock()
	data, err := os.ReadFile(persistFile)
	if err == nil {
		json.Unmarshal(data, &globalHistory)
		log.Printf("[Init] Loaded %d messages from history file", len(globalHistory))
	}
	// 起動時にディレクトリ設定を反映
	if historyDir != "" {
		_ = os.MkdirAll(historyDir, 0755)
	}
}

// ── WebSocket upgrader ───────────────────────────────────────
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 1024, // 1MB for image payloads
	WriteBufferSize: 1024 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

const (
	pingPeriod = 30 * time.Second
)

// ── Client management ────────────────────────────────────────
type Client struct {
	conn *websocket.Conn
	send chan []byte
	role string
	id   string
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]bool
}

var hub = &Hub{clients: make(map[*Client]bool)}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = true
	log.Printf("[Hub] Client registered: %s (role=%s)  total=%d", c.id, c.role, len(h.clients))
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
		log.Printf("[Hub] Client unregistered: %s  total=%d", c.id, len(h.clients))
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			// Set write deadline for stability
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) broadcast(msg []byte, exclude *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c == exclude {
			continue
		}
		select {
		case c.send <- msg:
		default:
			log.Printf("[Hub] Warning: Dropping message for slow client %s", c.id)
			// drop slow client
		}
	}
}

// ── Message types ────────────────────────────────────────────
type WSMessage struct {
	Type    string          `json:"type"`
	From    string          `json:"from,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	History []ChatPayload   `json:"history,omitempty"` // 履歴同期用
}

type ChatPayload struct {
	Text       string `json:"text"`
	Image      string `json:"image,omitempty"`
	Lang       string `json:"lang,omitempty"`
	Done       bool   `json:"done,omitempty"`
	ID         string `json:"id,omitempty"`
	IsUser     bool   `json:"isUser"`     // フロントエンドのMessage型と同期
	SenderName string `json:"senderName"` // 送信者名
}

// ── Ollama integration ───────────────────────────────────────
type OllamaChatMessage struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

type OllamaChatRequest struct {
	Model    string              `json:"model"`
	Messages []OllamaChatMessage `json:"messages"`
	Stream   bool                `json:"stream"`
}

type OllamaChatResponse struct {
	Message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"message"`
	Done bool `json:"done"`
}

// searchRAG reads text files from the rag/ directory and returns relevant snippets
// RAG_DIR 環境変数が設定されていればそのディレクトリを参照する
func searchRAG(query string) string {
	// ragSourceDir が設定されていなければ、RAG機能は無効
	if ragSourceDir == "" {
		return ""
	}

	ragMu.RLock()
	if time.Since(lastRagCheck) < 10*time.Second && ragCache != "" {
		defer ragMu.RUnlock()
		return ragCache
	}
	ragMu.RUnlock()

	ragMu.Lock()
	defer ragMu.Unlock()

	files, err := os.ReadDir(ragSourceDir)
	if err != nil {
		log.Printf("Warning: Could not read RAG directory '%s'. Please ensure it exists and has correct permissions: %v", ragSourceDir, err)
		return ""
	}

	var context bytes.Buffer
	for _, file := range files {
		// .txt または .md ファイルを対象
		if !file.IsDir() && (filepath.Ext(file.Name()) == ".txt" || filepath.Ext(file.Name()) == ".md") {
			content, err := os.ReadFile(filepath.Join(ragSourceDir, file.Name()))
			if err == nil {
				context.WriteString(fmt.Sprintf("--- File: %s ---\n%s\n", file.Name(), string(content)))
			}
		}
	}
	ragCache = context.String()
	lastRagCheck = time.Now()
	return context.String()
}

// queryOllama now accepts a callback to stream tokens back to the client
func queryOllama(payload ChatPayload, onChunk func(string)) error {
	// 外部のMarkdownファイルからシステムプロンプトを読み込む
	lang := payload.Lang
	if lang == "" {
		lang = "ja" // デフォルトは日本語
	}
	promptFile := filepath.Join(systemPromptDir, fmt.Sprintf("systemprompt_%s.md", lang))
	content, err := os.ReadFile(promptFile)
	if err != nil {
		log.Printf("[Warning] Could not read system prompt file %s: %v. Using fallback instructions.", promptFile, err)
		content = []byte("あなたは『sagbiちゃん』という3Dアバターです。楽しく友達のように答えてください。")
	}
	systemInstructions := string(content)

	messages := []OllamaChatMessage{
		{Role: "system", Content: systemInstructions},
	}

	context := searchRAG(payload.Text)
	if context != "" {
		// システムプロンプトを統合して優先順位を維持
		messages[0].Content += "\n\nReference from local knowledge:\n" + context
	}

	userMsg := OllamaChatMessage{
		Role:    "user",
		Content: payload.Text,
	}

	if payload.Image != "" {
		imgData := payload.Image
		if idx := bytes.Index([]byte(imgData), []byte(",")); idx != -1 {
			imgData = imgData[idx+1:]
		}
		userMsg.Images = []string{imgData}
	}
	messages = append(messages, userMsg)

	ollamaReq := OllamaChatRequest{
		Model:    ollamaModel,
		Messages: messages,
		Stream:   true,
	}

	reqBody, _ := json.Marshal(ollamaReq)

	// Ollamaのロードが極端に遅い場合に対応するため、トランスポートレベルでタイムアウトを制御
	client := &http.Client{
		Timeout: 3000 * time.Second,
		Transport: &http.Transport{
			ResponseHeaderTimeout: 3000 * time.Second,
		},
	}
	resp, err := client.Post(ollamaURL+"/api/chat", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("ollama request failed: %w", err)
	}
	defer resp.Body.Close()

	// Decode streaming JSON from Ollama
	decoder := json.NewDecoder(resp.Body)
	for {
		var chunk OllamaChatResponse
		if err := decoder.Decode(&chunk); err != nil {
			if err.Error() == "EOF" {
				break
			}
			return fmt.Errorf("failed to decode chunk: %w", err)
		}

		if chunk.Message.Content != "" {
			onChunk(chunk.Message.Content)
		}
		if chunk.Done {
			break
		}
	}
	return nil
}

// generateID produces a random hex string
func generateID(prefix string) string {
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("%s-%x", prefix, b)
}

// ── WebSocket handler ────────────────────────────────────────
func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}

	c := &Client{
		conn: conn,
		send: make(chan []byte, 1024), // Buffer for large messages
		id:   generateID("client"),
	}

	hub.register(c)
	defer hub.unregister(c)

	// Keep connection alive with Pong handler
	conn.SetReadLimit(10 * 1024 * 1024)                      // 10MB limit for base64 images
	conn.SetReadDeadline(time.Now().Add(3000 * time.Second)) // 5分まで許容
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(3000 * time.Second))
		return nil
	})

	// Start writer goroutine
	go c.writePump()

	// Reader loop
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		// メッセージ受信時も、長めのタイムアウトを維持（スマホの不安定な通信に対応）
		conn.SetReadDeadline(time.Now().Add(3000 * time.Second))

		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "register":
			var p struct {
				Role    string        `json:"role"`
				History []ChatPayload `json:"history,omitempty"`
			}
			_ = json.Unmarshal(msg.Payload, &p)
			c.role = p.Role

			// 1. まずサーバーが持っている最新履歴を接続したクライアントに送る
			historyMu.Lock()
			if len(globalHistory) > 0 {
				histMsg, _ := json.Marshal(WSMessage{Type: "history", History: globalHistory})
				c.send <- histMsg
			}
			historyMu.Unlock()

			// 2. クライアントから送られてきた履歴があれば、サーバー側のものと統合して同期
			if len(p.History) > 0 {
				historyMu.Lock()
				// IDベースで重複排除してマージ
				existingIDs := make(map[string]bool)
				for _, m := range globalHistory {
					if m.ID != "" {
						existingIDs[m.ID] = true
					}
				}

				mergedCount := 0
				for _, m := range p.History {
					if m.ID != "" && !existingIDs[m.ID] {
						globalHistory = append(globalHistory, m)
						mergedCount++
					}
				}
				historyMu.Unlock()
				if mergedCount > 0 {
					saveHistory()
					syncMsg, _ := json.Marshal(WSMessage{Type: "history", History: globalHistory})
					hub.broadcast(syncMsg, c)
					log.Printf("[WS] Merged %d new items from %s", mergedCount, c.id)
				}
			}

			// 自分のIDを通知する
			regMsg, _ := json.Marshal(WSMessage{
				Type:    "registered",
				Payload: json.RawMessage(fmt.Sprintf(`{"id":"%s"}`, c.id)),
			})
			c.send <- regMsg
			log.Printf("[WS] %s registered as %s", c.id, c.role)

		case "log":
			var l string
			_ = json.Unmarshal(msg.Payload, &l)
			fmt.Printf("[BROWSER] %s\n", l)

		case "chat_message":
			var p ChatPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			log.Printf("[Chat] %s: %s (image: %v)", c.id, p.Text, p.Image != "")

			// 質問の同期：ユーザーの質問をそのまま chat_message 型として他者に転送する。
			msg.From = fmt.Sprintf("User (%s)", c.id)
			// IDが空の場合のみ新規発行
			if p.ID == "" {
				p.ID = generateID("user")
			}
			p.IsUser = true
			p.SenderName = "You"

			historyMu.Lock()
			globalHistory = append(globalHistory, p)
			historyMu.Unlock()
			saveHistory()

			msg.Payload, _ = json.Marshal(p)
			broadcastRaw, _ := json.Marshal(msg)
			hub.broadcast(broadcastRaw, c) // 送信者を除外してブロードキャスト（自分はローカルで描画済みの為）

			// ── SAGBI DANCE FLOOR: 構造化ストーリー蓄積システム ──
			go func(payload ChatPayload, clientID string) {
				var story bytes.Buffer
				sessionID := time.Now().Format("20060102_150405")
				filename := ""

				if historyDir == "" {
					log.Printf("[Chat] History storage disabled (HISTORY_DIR not set).")
				} else {
					_ = os.MkdirAll(historyDir, 0755)
					filename = filepath.Join(historyDir, fmt.Sprintf("story_%s_%s.txt", sessionID, clientID))

					story.WriteString(fmt.Sprintf("--- SESSION: %s ---\n", sessionID))
					story.WriteString(fmt.Sprintf("[USER:%s] %s\n", clientID, payload.Text))

					if payload.Image != "" {
						story.WriteString(fmt.Sprintf("[USER:%s] [IMAGE] attached\n", clientID))
						imgData := payload.Image
						if idx := bytes.Index([]byte(imgData), []byte(",")); idx != -1 {
							imgData = imgData[idx+1:]
						}
						decoded, _ := base64.StdEncoding.DecodeString(imgData)
						imgFilename := filepath.Join(historyDir, fmt.Sprintf("media_%s_%s.jpg", sessionID, clientID))
						_ = os.WriteFile(imgFilename, decoded, 0644)
						story.WriteString(fmt.Sprintf("[LINK:IMAGE] %s\n", imgFilename))
					}
				}

				// AI回答生成
				var fullAnswer bytes.Buffer
				respMsg := WSMessage{
					Type: "chat_response",
					From: "SAGBI AI",
				}
				// 質問のIDに紐付けることで、再送時などの重複表示を防止
				aiResponseID := fmt.Sprintf("ai-%s", payload.ID)

				err := queryOllama(payload, func(chunk string) {
					fullAnswer.WriteString(chunk)
					// 逐次ブロードキャスト
					respMsg.Payload, _ = json.Marshal(ChatPayload{
						Text: fullAnswer.String(), // 累積した文字列を送信することで細切れを解消
						ID:   aiResponseID,
						Done: false,
					})
					respBytes, _ := json.Marshal(respMsg)
					hub.broadcast(respBytes, nil)
				})

				if err != nil {
					log.Printf("[Error] Ollama: %v", err)
					errMsg := fmt.Sprintf("AI接続エラー: %v", err)
					fullAnswer.WriteString(errMsg)
					respMsg.Payload, _ = json.Marshal(ChatPayload{Text: errMsg, ID: aiResponseID})
					respBytes, _ := json.Marshal(respMsg)
					hub.broadcast(respBytes, nil)
				} else {
					// 完了通知を送信
					respMsg.Payload, _ = json.Marshal(ChatPayload{
						Text:       fullAnswer.String(),
						ID:         aiResponseID,
						Done:       true,
						IsUser:     false,
						SenderName: "SAGBI AI",
					})
					// 履歴に追加
					historyMu.Lock()
					globalHistory = append(globalHistory, ChatPayload{
						Text: fullAnswer.String(), ID: aiResponseID, Done: true, IsUser: false, SenderName: "SAGBI AI",
					})
					historyMu.Unlock()
					saveHistory()

					finalBytes, _ := json.Marshal(respMsg)
					hub.broadcast(finalBytes, nil)
				}

				// 回答完了後に履歴を書き出し
				if filename != "" {
					story.WriteString(fmt.Sprintf("[AI:Sagbi] %s\n", fullAnswer.String()))
					story.WriteString("--- END SESSION ---\n")
					if err := os.WriteFile(filename, story.Bytes(), 0644); err != nil {
						log.Printf("[Error] Save history failed: %v", err)
					}
				}
			}(p, c.id)

		case "signal":
			// 送信元IDを付与して転送（WebRTC同期に必須）
			msg.From = c.id
			enrichedRaw, _ := json.Marshal(msg)
			hub.broadcast(enrichedRaw, c)

		default:
			log.Printf("[WS] Unknown message type: %s", msg.Type)
		}
	}
}

// ── HTTP handlers ────────────────────────────────────────────
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	hub.mu.RLock()
	count := len(hub.clients)
	hub.mu.RUnlock()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"clients": count,
		"model":   ollamaModel,
	})
}

// ── Main ─────────────────────────────────────────────────────
func main() {
	loadHistory()

	mux := http.NewServeMux()

	mux.HandleFunc("/ws/chat", handleWS)
	mux.HandleFunc("/healthz", healthHandler)

	// Serve static files (optional, for local dev)
	fs := http.FileServer(http.Dir("./static"))
	mux.Handle("/", fs)

	log.Printf("🚀 SAGBI Signaling Server starting on %s", listenAddr)
	log.Printf("   Ollama endpoint: %s (model: %s)", ollamaURL, ollamaModel)

	if ragSourceDir != "" {
		log.Printf("   RAG Source Directory: %s", ragSourceDir)
	} else {
		log.Printf("   RAG Source Directory: Not configured (RAG functionality disabled by default).")
	}
	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		// WebSocket接続を維持するため、サーバー全体のタイムアウトは設定しない
		ReadTimeout:  0,
		WriteTimeout: 0,
		IdleTimeout:  0,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
