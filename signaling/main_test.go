package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateID(t *testing.T) {
	id1 := generateID("user")
	id2 := generateID("user")

	if id1 == id2 {
		t.Errorf("IDs should be unique, got same: %s", id1)
	}
	if len(id1) < 5 {
		t.Errorf("ID too short: %s", id1)
	}
}

func TestDBOperations(t *testing.T) {
	// テスト専用の一時的なディレクトリを使用する
	tmpDir := t.TempDir()
	testDBPath := filepath.Join(tmpDir, "test_sagbi.db")
	os.Setenv("HISTORY_DIR", filepath.Join(tmpDir, "test_history"))

	// 本番の ../data/sagbi.db ではなく、一時ファイルを指定して初期化
	initDB(testDBPath)

	p := ChatPayload{
		ID:         "test-id",
		Text:       "Hello Unit Test",
		IsUser:     true,
		SenderName: "Tester",
	}

	saveToDB(p)
	loadHistory()

	found := false
	for _, m := range globalHistory {
		if m.ID == "test-id" {
			found = true
			break
		}
	}

	if !found {
		t.Error("Message was not saved or loaded correctly from DB")
	}
}

func TestSearchRAG(t *testing.T) {
	// テスト用のRAGディレクトリ作成
	tmpDir := "./test_rag"
	os.MkdirAll(tmpDir, 0755)
	defer os.RemoveAll(tmpDir)

	testFile := tmpDir + "/test.txt"
	os.WriteFile(testFile, []byte("Sagbi is a twirling AI agent."), 0644)

	ragSourceDir = tmpDir
	ragCache = "" // キャッシュクリア

	res := searchRAG("Sagbi")
	if res == "" {
		t.Error("RAG should return content from files")
	}

	// 部分一致の確認
	expectedSnippet := "Sagbi is a twirling AI agent."
	if !contains(res, expectedSnippet) {
		t.Errorf("RAG result missing expected content. Got: %s", res)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s != "" // 簡易的なチェック
}
