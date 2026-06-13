// 汎用エスケープ関数
const esc = (str) => {
    const text = (typeof str === 'object') ? JSON.stringify(str) : String(str);
    return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]));
};

// 永続化された文書のメタデータ（ファイル名）のみを格納
let persistentDocuments = [];

// 同一オリジンの他タブ/iframeとファイル更新を同期するためのチャネル
const syncChannel = new BroadcastChannel('plower_sync');
syncChannel.addEventListener('message', (event) => {
    if (event.data === 'update') {
        loadDocuments();
    }
});

// 現在解析対象となっている画像データ (Base64)
let currentImageBase64 = null;

// 現在解析対象となっている画像のベース名
let currentImageName = "";

// 現在解析対象となっている画像のオリジナルデータ (高画質)
let currentImageBlob = null;

// 言語設定の判定用 (初期値はブラウザ設定、後に質問内容で動的に更新)
let isEn = !navigator.language.startsWith('ja');

const isHttpsOrigin = window.location.protocol === 'https:';

// システムプロンプトのキャッシュ
let systemPromptCache = "";

// --- Sagbiブリッジ (Cloudflare Worker) 連携用 ---
let sagbiSocket = null;
const pendingLlmResolves = new Map();

const getSignalingUrl = () => {
    const urlParams = new URLSearchParams(window.location.search);
    let url = urlParams.get('s');
    if (url) return url;

    const host = window.location.hostname;
    // ローカル実行時は 8080 を優先
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${host}:8080/ws/chat`;
    } else {
        // 公開サイト (Pages) では Cloudflare Worker プロキシを経由
        const workerHost = "sagbi.biohack5079.workers.dev";
        return `wss://${workerHost}/ws/chat`;
    }
};

const PREVIEW_MAX_DOCS = 5; // コンテンツ表示エリアに表示する最大ファイル数

// --- OPFS (Origin Private File System) ヘルパー ---
async function getRagDir() {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('rag_sources', { create: true });
}

// 指定したファイルの内容をOPFSから読み込む
async function getDocumentContent(name) {
    if (name === '貼付けテキスト(一時)') return "";
    try {
        const ragDir = await getRagDir();
        const fileHandle = await ragDir.getFileHandle(name);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch (e) {
        console.error(`Failed to read file ${name}:`, e);
        return "";
    }
}

// 文書をOPFSに保存する
async function saveDocumentToOPFS(name, content) {
    try {
        const ragDir = await getRagDir();
        const fileHandle = await ragDir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        syncChannel.postMessage('update');
    } catch (e) {
        console.error(`Failed to save document ${name} to OPFS:`, e);
    }
}

// WebGPUモデルのキャッシュをクリアする関数
async function clearWebGpuModelCache() {
    const msgConfirm = isEn
        ? "Are you sure you want to delete all WebGPU model caches?\n(This will force models to be re-downloaded.)"
        : "本当にWebGPUモデルのキャッシュを全て削除しますか？\n（この操作は元に戻せません。モデルは次回使用時に再ダウンロードされます。）";
    if (confirm(msgConfirm)) {
        try {
            console.log("Starting WebGPU cache clear...");
            
            // 1. Cache API の削除
            if (window.caches) {
                const cacheKeys = await caches.keys();
                for (const key of cacheKeys) {
                    if (key.includes('transformers') || key.includes('onnx')) {
                        console.log(`Deleting cache: ${key}`);
                        await caches.delete(key).catch(e => console.warn(e));
                    }
                }
            }
            
            // 2. OPFS (Origin Private File System) のクリーンアップ
            if (navigator.storage && navigator.storage.getDirectory) {
                const root = await navigator.storage.getDirectory();
                for await (const entry of root.values()) {
                    try {
                        if (entry.kind === 'directory' && entry.name !== 'rag_sources') {
                            console.log(`Deleting OPFS dir: ${entry.name}`);
                            await root.removeEntry(entry.name, { recursive: true });
                        }
                    } catch (e) { console.warn(`OPFS entry skip: ${entry.name}`, e); }
                }
            }

            // 3. IndexedDB の削除
            if (window.indexedDB && indexedDB.databases) {
                const dbs = await indexedDB.databases();
                for (const dbInfo of dbs) {
                    try {
                        if (dbInfo.name.includes('onnx') || dbInfo.name.includes('transformers') || dbInfo.name.includes('ort')) {
                            console.log(`Deleting IDB: ${dbInfo.name}`);
                            indexedDB.deleteDatabase(dbInfo.name);
                        }
                    } catch (e) { console.warn(`IDB delete skip: ${dbInfo.name}`, e); }
                }
            }

            console.log("Storage cleared. Reloading...");
            location.reload(); // 確実にクリーンな状態にするためリロード
        } catch (e) {
            console.error("Critical storage error:", e);
            const isNoSpace = e.message.includes('NO_DEVICE_SPACE') || e.name === 'QuotaExceededError';
            const msg = isNoSpace 
                ? (isEn ? "Disk is critically full. The app cannot even delete files.\n\nPlease open Browser Settings -> Privacy -> Cookies and Site Data -> Manage Data, and manually delete data for this site."
                        : "ディスク容量が完全に不足しており、アプリ内から消去命令すら実行できません。\n\nブラウザの「設定 ＞ プライバシー ＞ クッキーとサイトデータ ＞ データの管理」から、このサイトのデータを手動で削除してください。")
                : (isEn ? "An error occurred while clearing cache." : "キャッシュの削除中にエラーが発生しました。");
            alert(msg);
        }
    }
}
// 動的に作成されるHTML（エラー通知の赤いボタンなど）から呼び出せるようにグローバルに公開
window.clearWebGpuModelCache = clearWebGpuModelCache;

// --- OPFSからの文書ロードとファイル一覧の表示 ---
async function loadDocuments() {
    // 127.0.0.1 使用時と隔離状態のチェック
    const isIsolated = window.crossOriginIsolated;
    if (window.location.hostname === '127.0.0.1') {
        const localhostMsg = isEn 
            ? "⚠️ Using 127.0.0.1. Please switch to 'localhost' for full OPFS support."
            : "⚠️ 127.0.0.1 でアクセス中です。OPFSを正常に動作させるため、URLの 127.0.0.1 を localhost に書き換えてください。";
        console.warn(localhostMsg);
    }
    console.log(`[Storage] Cross-Origin Isolated: ${isIsolated}`);
    if (!isIsolated) console.warn("Performance and OPFS might be limited. COOP/COEP headers are missing.");

    // ストレージの状態を確認（ユーザーの不安解消用）
    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(async estimate => {
            const usage = estimate.usage || 0;
            const quota = (estimate.quota / 1024 / 1024 / 1024).toFixed(2);
            const usedGB = usage / 1024 / 1024 / 1024;

            // ストレージの永続化状態を確認
            let persisted = false;
            if (navigator.storage.persisted) {
                persisted = await navigator.storage.persisted();
            }

            const used = (usedGB < 0 || usedGB > 1000) ? "Fatal" : usedGB.toFixed(2);
            // クォータが10GB程度で止まっている場合は一時ストレージ制限を受けています
            const hasGpu = !!navigator.gpu;
            
            console.log(`[Storage] Status Check:`);
            console.table({
                "Used (GB)": used,
                "Quota (GB)": quota,
                "Persisted": persisted,
                "Isolated": isIsolated,
                "WebGPU": hasGpu,
                "Environment": navigator.userAgent.includes("Snap") ? "Ubuntu Snap (Restricted)" : "Standard"
            });

            // UIにストレージ情報を表示（もし要素があれば）
            const storageInfoEl = document.getElementById('storageInfo');
            if (!storageInfoEl) {
                const container = document.getElementById('statusBar');
                if (!container) return;

                const span = document.createElement('span');
                span.id = 'storageInfo';
                span.style.cssText = 'display:inline-block; font-size:0.9em; font-weight:normal; vertical-align:middle;';
                container.appendChild(span);
            }

            const targetEl = document.getElementById('storageInfo');
            if (targetEl) {
                const isolationLabel = isIsolated ? (isEn ? '🛡️Isolated' : '🛡️隔離ON') : (isEn ? '🔓Non-Isolated' : '🔓隔離OFF');
                const isHighUsage = (used / quota) > 0.8;
                const usageColor = isHighUsage ? '#d32f2f' : (persisted ? '#2e7d32' : '#666');
                targetEl.innerHTML = `容量: <span style="color:${usageColor}; font-weight:bold;">${used}/${quota}GB</span> ${persisted ? '✅永続化済' : '⚠️一時的'} | ${isolationLabel}`;

                // 永続化リクエストボタンの追加
                if (!persisted && !document.getElementById('persistBtn')) {
                    const btn = document.createElement('button');
                    btn.id = 'persistBtn';
                    btn.textContent = isEn ? 'Unlock Storage' : '永続化';
                    btn.style.cssText = 'display:inline-flex; align-items:center; margin-left:8px; background:#d32f2f; color:white; border:none; border-radius:4px; padding:0 8px; cursor:pointer; font-size:11px; height:24px; vertical-align:middle; font-weight:bold;';
                    
                    btn.onmouseover = () => btn.style.background = '#b71c1c';
                    btn.onmouseout = () => btn.style.background = '#d32f2f';

                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        try {
                            // ユーザーの明示的なクリック操作内でのみリクエストが有効
                            const granted = await navigator.storage.persist();
                            if (granted) {
                                alert(isEn ? "Persistence enabled! Reloading to apply large quota..." : "永続化が許可されました！クォータ拡大のためリロードします。");
                                location.reload();
                            } else {
                                const score = "chrome://site-engagement/";
                                const msg = isEn
                                    ? `Chrome denied the request even with high score.\n\n【Ubuntu/Snap Problem】\nIf score is high but still denied, the "Snap" version of Chrome is likely blocking it. \n\nSolution: Install the official ".deb" version from Google's site instead of Snap.\nAlso try: Bookmark this page and Reload.`
                                    : `スコアが十分（100など）なのに拒否されました。これはUbuntuのSnap版Chrome特有の制限である可能性が高いです。\n\n【解決策】\n1. Ubuntuの「Snap版」Chromeではなく、Google公式サイトから「.deb版」をダウンロードしてインストールしてください。Snap版はセキュリティ隔離が厳しく、永続化が通らないことがよくあります。\n2. このページをブックマークし、一度リロードしてから再試行してください。`;
                                
                                if (confirm(msg + (isEn ? "\n\nCopy score URL to clipboard?" : "\n\nスコア確認用URLをクリップボードにコピーしますか？"))) {
                                    navigator.clipboard.writeText(score);
                                }
                                console.info(`Check your engagement score at: ${score}`);
                            }
                        } catch (err) {
                            console.error("Persistence request error:", err);
                        }
                    };
                    targetEl.appendChild(btn);
                }
                targetEl.title = persisted ? "ブラウザから削除されにくい設定です" : "容量制限が厳しく、ブラウザの判断で削除される可能性があります。";
            }

            // 20GB未満、または永続化されていない場合に警告 (Gemma 2等の巨大モデル用)
            if (estimate.quota < 20 * 1024 * 1024 * 1024 && !persisted) {
                const scoreUrl = "chrome://site-engagement/";
                console.warn(`[Storage] Chrome has restricted quota to ${quota}GB.\nPossible Reasons:\n1. Site Engagement Score < 4.1 (Current check: ${scoreUrl})\n2. Ubuntu Snap environment restriction.\n3. OS disk space is low.\nRecommended: Use 'localhost' and official Chrome .deb version.`);
            }
        });
    }
    try {
        const ragDir = await getRagDir();
        const docs = [];
        for await (const entry of ragDir.values()) {
            if (entry.kind === 'file') {
                try {
                    // ファイルの実体にアクセス可能か検証（幽霊ファイルを排除）
                    await ragDir.getFileHandle(entry.name);
                    docs.push({ name: entry.name });
                } catch (e) {
                    console.warn(`Cleaned up stale file handle: ${entry.name}`);
                }
            }
        }
        persistentDocuments = docs;
        updateFileListDisplay();
    } catch (e) {
        console.error("Failed to load documents from OPFS:", e);
        persistentDocuments = [];
    }
}

// システムプロンプトを外部ファイルからロードする
async function loadSystemPrompt(forceLang = null) {
    const targetIsEn = forceLang !== null ? forceLang === 'en' : isEn;
    const promptFile = targetIsEn ? './systemprompt_en.md' : './systemprompt_ja.md';
    try {
        const response = await fetch(promptFile);
        if (response.ok) {
            systemPromptCache = await response.text();
        }
    } catch (e) {
        console.error("Failed to load system prompt:", e);
    }
}

// ヘルパー: Blobを同期フォルダに書き込む
async function saveBlobToDirectory(blob, filename) {
    if (!directoryHandle) return false;
    try {
        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    } catch (e) {
        console.error("Failed to auto-save to directory:", e);
        return false;
    }
}

// RAGソースをリセットする関数 (OPFSディレクトリの削除)
async function resetDocuments() {
    const msgConfirm = isEn 
        ? "Are you sure you want to delete all RAG source documents?\n(This cannot be undone. All uploaded files will be cleared from LocalStorage.)"
        : "本当にRAGソース文書を全て削除しますか？\n（この操作は元に戻せません。アップロードされたファイルがストレージから全て消去されます。）";
    if (confirm(msgConfirm)) {
        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry('rag_sources', { recursive: true });

            syncChannel.postMessage('update');
            persistentDocuments = [];
            document.getElementById('pasteArea').value = '';
            clearOcrDisplay();

            // 同期設定のクリア
            directoryHandle = null;
            if (syncInterval) clearInterval(syncInterval);

            // UIを更新
            updateFileListDisplay(); 
            
            alert(isEn ? "All RAG source documents have been reset." : "RAGソース文書を全てリセットしました。");
        } catch (e) {
            console.error("Failed to reset documents:", e);
            alert(isEn ? "An error occurred during reset." : "リセット中にエラーが発生しました。");
        }
    }
}

// OCR/画像関連の表示をクリアするヘルパー関数
function clearOcrDisplay() {
    // 既存のOCR関連要素をクリア
    // 画像とステータスを両方削除します
    document.querySelectorAll('#fileContent img, #fileContent .ocr-status').forEach(el => el.remove());
}

// --- ファイル一覧表示の更新とクリックイベント設定 ---
async function updateFileListDisplay() {
    const fileListUl = document.getElementById('fileListUl');
    const fileContentDiv = document.getElementById('fileContent');
    fileListUl.innerHTML = '';
    
    // 解析中の画像やステータス表示を一時退避（リスト更新で消えないようにするため）
    const ocrElements = Array.from(fileContentDiv.children).filter(el => 
        el.classList.contains('ocr-status') || el.tagName === 'IMG' || (el.tagName === 'DIV' && el.querySelector('img'))
    );

    // ファイル名のリストを生成
    persistentDocuments.forEach((doc, index) => {
        const li = document.createElement('li');
        
        // モバイル対応: レイアウトをFlexにしてメニューボタンを追加
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = doc.name;
        nameSpan.style.flexGrow = '1';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.whiteSpace = 'nowrap';
        li.appendChild(nameSpan);

        // メニューボタン (︙)
        const menuBtn = document.createElement('span');
        menuBtn.innerHTML = '&#x22EE;'; // 縦の三点リーダー
        menuBtn.style.cursor = 'pointer';
        menuBtn.style.padding = '0 5px 0 10px';
        menuBtn.style.fontSize = '1.2em';
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            const rect = e.target.getBoundingClientRect();
            createContextMenu({ pageX: rect.left + window.scrollX, pageY: rect.bottom + window.scrollY, preventDefault: () => {} }, index);
        };
        li.appendChild(menuBtn);

        li.title = doc.name; // ホバーでフルネームを表示
        li.dataset.docIndex = index;
        li.onclick = () => {
            clearOcrDisplay();
            showDocumentContent(index);
        };
        // 右クリックメニュー (コンテキストメニュー) の追加
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            createContextMenu(e, index);
        });
        fileListUl.appendChild(li);
    });
    
    // コンテンツ表示エリアの初期表示（最新の数ファイル）
    let initialContent = isEn ? '<h3>RAG Source Document Preview (Latest 5)</h3>\n' : '<h3>RAGソース文書プレビュー (最新5件)</h3>\n';
    const recentDocs = persistentDocuments.slice(-PREVIEW_MAX_DOCS).reverse();
    
    if (recentDocs.length > 0) {
        for (const doc of recentDocs) {
            initialContent += `<p><strong>【${doc.name}】</strong></p>`;
            // 内容をオンデマンドで読み込む
            const content = await getDocumentContent(doc.name);
            
            if (content.startsWith('data:image/')) {
                // 画像の場合はサムネイルを表示
                initialContent += `<div style="margin-bottom:10px;"><img src="${content}" style="max-width:200px; max-height:150px; border:1px solid #ccc; border-radius:4px;"></div>`;
            } else {
                // テキストの場合は内容の一部を表示
                initialContent += `<pre>--- ${isEn ? 'File Name' : 'ファイル名'}: ${doc.name} ---\n${content.slice(0, 300)}${content.length > 300 ? '...' : ''}</pre>\n`;
            }
        }
    } else {
        initialContent += isEn ? '<p>No RAG source documents available.</p>' : '<p>現在RAGのソースとなる文書はありません。</p>';
    }
    fileContentDiv.innerHTML = initialContent;
    
    // 退避しておいたOCR要素をプレビューエリアに再挿入
    ocrElements.forEach(el => fileContentDiv.prepend(el));
}

// --- ファイル名クリック時の内容表示 ---
async function showDocumentContent(index) {
    const fileContentDiv = document.getElementById('fileContent');
    const doc = persistentDocuments[index];
    if (doc) {
        let contentHtml = `<h3>${isEn ? 'Selected File' : '選択中のファイル'}: ${doc.name}</h3>`;
        const content = await getDocumentContent(doc.name);
        if (content.startsWith('data:image/')) {
            contentHtml += `<img src="${content}" style="max-width:100%; border:1px solid #ddd; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">`;
        } else {
            contentHtml += `<pre>${content}</pre>`;
        }
        fileContentDiv.innerHTML = contentHtml;
    }
}

// --- コンテキストメニュー (右クリック) 関連 ---
function createContextMenu(e, index) {
    // 既存のメニューがあれば削除
    const existingMenu = document.getElementById('customContextMenu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'customContextMenu';
    menu.style.position = 'absolute';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;
    menu.style.backgroundColor = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '2px 2px 5px rgba(0,0,0,0.2)';
    menu.style.zIndex = '1000';
    menu.style.padding = '5px 0';
    menu.style.minWidth = '120px';
    menu.style.borderRadius = '4px';

    const createMenuItem = (text, onClick, color = 'black') => {
        const item = document.createElement('div');
        item.textContent = text;
        item.style.padding = '8px 12px';
        item.style.cursor = 'pointer';
        item.style.fontSize = '14px';
        item.style.color = color;
        item.onmouseover = () => item.style.backgroundColor = '#f0f0f0';
        item.onmouseout = () => item.style.backgroundColor = 'white';
        item.onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            onClick();
        };
        return item;
    };

    menu.appendChild(createMenuItem(isEn ? 'Rename' : '名前を変更', () => renameDocument(index)));
    menu.appendChild(createMenuItem(isEn ? 'Delete' : '削除', () => deleteDocument(index), 'red'));

    document.body.appendChild(menu);

    const closeMenu = (event) => {
        if (!menu.contains(event.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// 共通のファイル名入力ダイアログ (拡張子を除いた部分を選択状態にする)
function showRenameDialog(titleText, initialValue) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
        overlay.style.zIndex = '2000';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';

        const dialog = document.createElement('div');
        dialog.style.backgroundColor = 'white';
        dialog.style.padding = '20px';
        dialog.style.borderRadius = '8px';
        dialog.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
        dialog.style.minWidth = '300px';

        const title = document.createElement('h3');
        title.textContent = titleText;
        title.style.marginTop = '0';
        title.style.marginBottom = '15px';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initialValue;
        input.style.width = '100%';
        input.style.padding = '8px';
        input.style.marginBottom = '20px';
        input.style.boxSizing = 'border-box';
        input.style.fontSize = '16px';

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.gap = '10px';

        const closeDialog = (val) => {
            overlay.remove();
            resolve(val);
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = isEn ? 'Cancel' : 'キャンセル';
        cancelBtn.style.padding = '6px 12px';
        cancelBtn.style.cursor = 'pointer';
        cancelBtn.onclick = () => closeDialog(null);
        
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '6px 12px';
        okBtn.style.cursor = 'pointer';
        okBtn.onclick = () => {
            const val = input.value.trim();
            if (val) closeDialog(val);
        };

        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        input.focus();
        const lastDotIndex = initialValue.lastIndexOf('.');
        if (lastDotIndex > 0) {
            input.setSelectionRange(0, lastDotIndex);
        } else {
            input.select();
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') okBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
        });
    });
}

// Hugging Face 認証エラー用のダイアログを表示し、トークンの入力を待つ
async function showAuthDialog(modelId, technicalError = "") {
    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.6)';
        overlay.style.zIndex = '3000';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.backdropFilter = 'blur(4px)';

        const dialog = document.createElement('div');
        dialog.style.backgroundColor = 'white';
        dialog.style.padding = '25px';
        dialog.style.borderRadius = '12px';
        dialog.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';
        dialog.style.maxWidth = '450px';
        dialog.style.width = '90%';

        // モデルが「Gated(規約同意が必要)」かどうかを判定
        const repoUrl = `https://huggingface.co/${modelId}`;
        let licenseUrl = "";
        const midLower = modelId.toLowerCase();
        const isGated = midLower.includes('gemma') || midLower.includes('llama');

        if (midLower.includes('gemma-2')) {
            licenseUrl = `https://huggingface.co/google/gemma-2-2b-it`;
        } else if (midLower.includes('gemma')) {
            licenseUrl = `https://huggingface.co/google/gemma-7b`;
        } else if (midLower.includes('llama')) {
            licenseUrl = `https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct`;
        }

        const tokenUrl = `https://huggingface.co/settings/tokens`;
        const licenseSection = licenseUrl ? `
            <div style="background:#fff3cd; padding:12px; border-radius:6px; margin-bottom:15px; font-size:13px; border-left: 4px solid #ffc107; color: #856404;">
                <strong>Step 1: ${isEn ? 'Accept License' : '公式リポジトリで規約同意'}</strong><br>
                ${isEn ? 'This model requires explicit agreement. Click below and "Agree and access":' : 'このモデルは利用規約への同意が必要です。以下を開き「Agree and access」を押してください：'}<br>
                <a href="${licenseUrl}" target="_blank" style="color:#856404; font-weight:bold; word-break:break-all; text-decoration:underline;">${licenseUrl}</a>
            </div>` : '';

        const title = isGated ? (isEn ? 'License Required' : '規約同意と認証が必要です') : (isEn ? 'Model Load Error' : 'モデルの読み込みに失敗しました');
        const mainMsg = isGated 
            ? (isEn ? `Access denied. Please check your token and license agreement.` : `アクセスが拒否されました。トークンの有効性または公式リポジトリでの規約同意を確認してください。`)
            : (isEn ? `Failed to load model. Check the ID or network.` : `モデルの読み込みに失敗しました。IDまたは接続を確認してください。`);

        dialog.innerHTML = `
            <h3 style="margin-top:0; color:#d32f2f;">${title}</h3>
            <p style="font-size:14px; line-height:1.5;">${mainMsg}</p>
            <div style="background:#fff1f0; color:#d32f2f; padding:8px; border-radius:4px; font-size:12px; margin-bottom:15px; border:1px solid #ffa39e; word-break:break-all;">
                <strong>Error:</strong> ${esc(technicalError || 'Unknown Error')}
            </div>
            ${licenseSection}
            <div style="background:#f9f9f9; padding:12px; border-radius:6px; margin-bottom:15px; font-size:13px; border-left: 4px solid #007bff;">
                <strong>${isEn ? 'Target Repository' : '読み込み先リポジトリ'}:</strong><br>
                <a href="${repoUrl}" target="_blank" style="color:#007bff; text-decoration:underline; word-break:break-all; display:block; margin-top:5px; font-weight:bold;">${repoUrl}</a>
                <p style="margin-top:8px; font-size:12px; color:#666;">
                    ${isEn ? 'Note: Large models like Gemma 2 may be evicted from cache if disk space is low, causing re-downloads.' : '※補足: Gemma 2等の巨大モデルは、ディスク残量が少ないとブラウザがキャッシュを自動削除し、再ダウンロードが発生することがあります。'}
                </p>
            </div>
            ${isGated ? `
            <div style="background:#f9f9f9; padding:12px; border-radius:6px; margin-bottom:15px; font-size:13px; border-left: 4px solid #28a745;">
                <strong>${isEn ? 'Token Scope' : 'トークンの権限確認'}:</strong><br>
                <a href="${tokenUrl}" target="_blank" style="color:#28a745; text-decoration:underline;">${isEn ? 'Settings' : '設定を開く'}</a> ("Read" or "Gated Models" scope)
            </div>` : ''}
            <div style="margin-bottom:20px;">
                <label style="display:block; font-size:13px; font-weight:bold; margin-bottom:5px;">${isEn ? 'HF Token (Optional)' : 'HFトークン（任意）'}</label>
                <input type="password" id="authDialogToken" placeholder="hf_..." style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                <small style="color: #666; font-size: 11px; display: block; margin-top: 4px;">${isEn ? 'Tip: "Read" scope is sufficient.' : 'ヒント: "Read"スコープのトークンで十分です。'}</small>
            </div>
            <div style="display:flex; flex-wrap:wrap; justify-content:flex-end; gap:12px;">
                ${!isGated ? `<button id="authDialogNoToken" style="padding:8px 12px; background:#f0f0f0; border:1px solid #ccc; border-radius:4px; cursor:pointer;">${isEn ? 'Try without token' : 'トークンなしで試す'}</button>` : ''}
                <div style="flex-grow:1;"></div>
                <button id="authDialogCancel" style="padding:8px 16px; background:none; border:1px solid #ccc; border-radius:4px; cursor:pointer;">${isEn ? 'Cancel' : 'キャンセル'}</button>
                <button id="authDialogRetry" style="padding:8px 20px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">${isEn ? 'Retry' : '再試行'}</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const tokenInput = dialog.querySelector('#authDialogToken');
        tokenInput.value = localStorage.getItem('plowerHfToken') || '';
        tokenInput.focus();

        const cleanup = () => {
            document.body.removeChild(overlay);
        };

        dialog.querySelector('#authDialogCancel').onclick = () => {
            cleanup();
            reject();
        };

        dialog.querySelector('#authDialogNoToken').onclick = () => {
            cleanup();
            resolve(""); // トークンなし（空文字）でリトライ
        };

        dialog.querySelector('#authDialogRetry').onclick = () => {
            const token = tokenInput.value.trim();
            cleanup();
            resolve(token); // 空文字の場合もそのまま解決（トークンなしリトライを許容）
        };

        tokenInput.onkeydown = (e) => {
            if (e.key === 'Enter') dialog.querySelector('#authDialogRetry').click();
        };
    });
}

async function renameDocument(index) {
    const doc = persistentDocuments[index];
    const newName = await showRenameDialog(isEn ? 'Rename' : '名前を変更', doc.name);
    if (newName && newName !== doc.name) {
        const content = await getDocumentContent(doc.name);
        await saveDocumentToOPFS(newName, content);
        
        const ragDir = await getRagDir();
        await ragDir.removeEntry(doc.name);
        
        syncChannel.postMessage('update');
        doc.name = newName;
        updateFileListDisplay();
    }
}

async function deleteDocument(index) {
    const doc = persistentDocuments[index];
    const msg = isEn ? `Are you sure you want to delete "${doc.name}"?` : `本当に「${doc.name}」を削除しますか？`;
    if (confirm(msg)) {
        const ragDir = await getRagDir();
        await ragDir.removeEntry(doc.name);
        
        syncChannel.postMessage('update');
        persistentDocuments.splice(index, 1);
        updateFileListDisplay();
    }
}

// --- File System Access API 関連 ---
let directoryHandle = null;
let syncInterval = null;

// ローカルフォルダと同期する関数
async function syncLocalFolder() {
    if (!('showDirectoryPicker' in window)) {
        alert(isEn ? 'Your browser does not support File System Access API.' : 'お使いのブラウザはローカルフォルダ同期(File System Access API)をサポートしていません。PC版ChromeやEdgeをご利用ください。');
        return;
    }

    // 既存の同期を停止
    if (syncInterval) clearInterval(syncInterval);

    try {
        // ユーザーにフォルダを選択させる
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        directoryHandle = handle;
        
        const msg = isEn 
            ? `Start syncing with folder "${handle.name}"?\nFiles in this folder will be automatically synced.`
            : `フォルダ「${handle.name}」と同期を開始しますか？\nこのフォルダ内のファイルは自動的に同期（追加・更新）されます。`;

        if (confirm(msg)) {
            // 初回読み込み (UI表示あり)
            await loadFilesFromDirectory(false);
            // 自動同期タイマーを開始 (10秒ごとにチェック)
            syncInterval = setInterval(() => loadFilesFromDirectory(true), 10000);
        }

    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('フォルダ選択中にエラーが発生しました:', err);
            alert(isEn ? 'Error selecting folder.' : 'フォルダ選択中にエラーが発生しました。');
        }
    }
}

// 選択されたディレクトリからファイルを読み込む関数
async function loadFilesFromDirectory(isSilent = false) {
    if (!directoryHandle) return;

    const fileContentDiv = document.getElementById('fileContent');
    
    // サイレントモードでない場合のみローディング表示
    if (!isSilent) {
        fileContentDiv.innerHTML = isEn ? '<h3>Syncing files...</h3><div class="spinner"></div>' : '<h3>同期フォルダからファイルを読み込み中...</h3><div class="spinner"></div>';
    }

    try {
        const scannedDocs = [];

        // 再帰的にファイルを読み込むヘルパー関数
        async function readDirectoryRecursive(dirHandle, pathPrefix = '') {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    if (/\.(txt|md|log|py|js|json|c|cpp|h|java|html|css|csv|rb|go|rs|php)$/i.test(entry.name)) {
                        try {
                            const file = await entry.getFile();
                            const content = await file.text();
                            // パスを含めた名前で保存 (例: subfolder/file.txt)
                            scannedDocs.push({ name: pathPrefix + entry.name, content: content });
                        } catch (e) {
                            console.warn(`Skipped file: ${entry.name}`, e);
                        }
                    }
                } else if (entry.kind === 'directory') {
                    await readDirectoryRecursive(entry, pathPrefix + entry.name + '/');
                }
            }
        }

        await readDirectoryRecursive(directoryHandle);

        if (scannedDocs.length === 0) {
            if (!isSilent) {
                alert(isEn ? "No text files found." : "読み込み可能なテキストファイルが見つかりませんでした。");
                updateFileListDisplay();
            }
            return;
        }

        let changesMade = false;
        let addedCount = 0;
        let updatedCount = 0;

        // マージロジック: 既存の文書を更新または新規追加
        for (const doc of scannedDocs) {
            const isNew = !persistentDocuments.some(d => d.name === doc.name);
            await saveDocumentToOPFS(doc.name, doc.content);
            if (isNew) {
                persistentDocuments.push({ name: doc.name });
                addedCount++;
            } else {
                updatedCount++;
            }
            changesMade = true;
        }

        if (changesMade) {
            updateFileListDisplay(); // ファイル一覧を更新
            if (!isSilent) {
                alert(isEn ? `Synced: ${addedCount} added, ${updatedCount} updated.` : `フォルダ「${directoryHandle.name}」から ${addedCount} 件追加、${updatedCount} 件更新しました。`);
            } else {
                console.log(`Auto-sync: Added ${addedCount}, Updated ${updatedCount}`);
            }
        } else {
            if (!isSilent) {
                alert(isEn ? "Files are up to date." : "ファイルの内容は最新です。");
                updateFileListDisplay(); // 表示を復元
            }
        }

    } catch (err) {
        console.error('フォルダからのファイル読み込み中にエラーが発生しました:', err);
        if (!isSilent) {
            alert(isEn ? 'Error syncing files.' : 'フォルダからのファイル読み込み中にエラーが発生しました。');
            updateFileListDisplay(); // 表示を復元
        }
    }
}

// --- ファイル入力のイベントリスナー ---
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            const files = this.files;
            if (files.length === 0) return;
            
            Array.from(files).forEach(async file => {
                if (file.size > 10 * 1024 * 1024) {
                    alert(isEn ? `File "${file.name}" exceeds 10MB limit.` : `ファイル「${file.name}」はサイズ制限（10MB）を超えているためスキップされました。`);
                    return;
                }

                if (file.type.startsWith('image/')) {
                    await processImageSource(file);
                } else {
                    const reader = new FileReader();
                    reader.onload = function (e) {
                        saveDocumentToOPFS(file.name, e.target.result);
                        persistentDocuments.push({ name: file.name });
                        updateFileListDisplay();
                    };
                    reader.readAsText(file);
                }
            });
            
            this.value = ''; // 連続アップロードのためにinputをクリア
        });
    }
});

// --- 貼り付け画像処理のイベントリスナー (OCR連携ロジック) ---
async function handlePaste(e) {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault(); 
            const blob = item.getAsFile();
            processImageSource(blob);
            break;
        }
    }
}

// --- 画像解析(OCR)とプレビュー・JPG保存処理 ---
async function processImageSource(fileOrBlob) {
    const isFile = fileOrBlob instanceof File;
    currentImageBlob = fileOrBlob; // オリジナルの高画質データを保持
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // ブラウザの貼り付けなどで「image.png」や「img」という名前になることが多いため、
    // 名前が汎用的な場合はタイムスタンプ付きの長い名前に置き換える
    const baseName = isFile ? fileOrBlob.name.replace(/\.[^/.]+$/, "") : "";
    const isGeneric = !baseName || /^(image|img)\d*$/i.test(baseName);
    currentImageName = isGeneric ? `pasted_image_${timestamp}` : baseName;

    const name = `${currentImageName}.jpg`;
    const fileContentDiv = document.getElementById('fileContent');

    const processingMessage = document.createElement('p');
    processingMessage.className = 'ocr-status';
    processingMessage.style.fontWeight = 'bold';
    processingMessage.textContent = isEn ? `Image ready: ${name}` : `画像を確認しました: ${name}`;
    fileContentDiv.prepend(processingMessage);

    const reader = new FileReader();
    reader.onload = async function (event) {
        const base64Image = event.target.result;

        const container = document.createElement('div');
        container.style.margin = "10px 0";
        container.style.padding = "10px";
        container.style.border = "1px solid #ddd";
        container.style.borderRadius = "5px";
        container.style.backgroundColor = "#fff";

        const img = document.createElement('img');
        img.src = base64Image;
        img.style.maxWidth = '100%';
        img.style.display = 'block';
        img.style.marginBottom = '10px';
        container.appendChild(img);

        const dlBtn = document.createElement('button');
        dlBtn.textContent = isEn ? 'Download as JPG' : 'JPGとして保存';
        dlBtn.style.padding = "5px 15px";
        
        // JPG変換ロジック
        const tempImg = new Image();
        tempImg.onload = () => {
            const canvas = document.createElement('canvas');
            // メモリ消費を抑えるため、最大サイズを1024pxに制限
            const MAX_SIZE = 1024;
            let width = tempImg.width;
            let height = tempImg.height;
            if (width > height) {
                if (width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                }
            } else {
                if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(tempImg, 0, 0);
            const jpegUrl = canvas.toDataURL('image/jpeg', 0.8);
            dlBtn.onclick = () => {
                const link = document.createElement('a');
                link.href = jpegUrl;
                link.download = name.split('.')[0] + ".jpg";
                link.click();
            };
            currentImageBase64 = jpegUrl; // LLM送信用に保持
        };
        tempImg.src = base64Image;

        container.appendChild(dlBtn);
        fileContentDiv.prepend(container);

        // 解析を待たずに保存を確認
        setTimeout(() => {
            const msg = isEn 
                ? `Image "${name}" detected. Save this image to RAG source?` 
                : `画像「${name}」を検出しました。この画像をRAGソース（永続ファイル）に保存しますか？`;
            if (confirm(msg)) {
                saveOcrTextAsFile();
            }
        }, 100);
    };
    reader.readAsDataURL(fileOrBlob);
}

// --- OCR/貼付テキストのファイル保存と永続化 ---

async function saveOcrTextAsFile() {
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    if (!currentImageBase64 && !pasteAreaContent) {
        alert(isEn ? "No content to save." : "永続化する内容がありません。");
        return;
    }

    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    // 画面上の表示やダイアログの初期値は .jpg に統一（ユーザーへの表示用）
    let defaultFilename = currentImageBase64 ? `${currentImageName || 'plower_image_' + timestamp}.jpg` : `plower_memo_${timestamp}.txt`;
    const filename = await showRenameDialog(isEn ? 'Save As' : '名前を付けて保存', defaultFilename);
    if (!filename) return;

    let contentToSave = '';
    let fileBlob;

    // 画像がある場合の処理
    if (currentImageBase64) {
        // ローカル保存用のファイル名は、UI上の拡張子に関わらず .png に強制（高画質を維持）
        const downloadName = filename.replace(/\.[^/.]+$/, "") + ".png";

        // 1. ローカルフォルダ/ダウンロード用 (オリジナルの Blob をそのまま使用 = 高画質)
        fileBlob = currentImageBlob;

        // 2. 内部ストレージ(IndexedDB)用 (JPG - ブラウザの容量制限対策のため圧縮版を使用)
        const tempImg = new Image();
        await new Promise(resolve => { tempImg.onload = resolve; tempImg.src = currentImageBase64; });
        const canvas = document.createElement('canvas');
        canvas.width = tempImg.width; canvas.height = tempImg.height;
        canvas.getContext('2d').drawImage(tempImg, 0, 0);
        contentToSave = canvas.toDataURL('image/jpeg', 0.7);

        // 同期フォルダがあれば .png として保存
        if (directoryHandle) {
            await saveBlobToDirectory(fileBlob, downloadName);
        }

        // ファイルとしてダウンロード実行 (.png として保存)
        if (fileBlob) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(fileBlob);
            link.download = downloadName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        alert(isEn ? `Saved as "${downloadName}".` : `「${downloadName}」として保存し、RAGソースに追加しました。`);
    } else {
        contentToSave = pasteAreaContent;
        fileBlob = new Blob([contentToSave], { type: 'text/plain;charset=utf-8' });

        if (fileBlob) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(fileBlob);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        alert(isEn ? `Saved as "${filename}".` : `「${filename}」として保存し、RAGソースに追加しました。`);
    }

    if (contentToSave) {
        await saveDocumentToOPFS(filename, contentToSave);
        if (!persistentDocuments.some(d => d.name === filename)) {
            persistentDocuments.push({ name: filename });
        }
    }
    
    document.getElementById('pasteArea').value = '';
    currentImageBase64 = null;
    currentImageBlob = null;
    currentImageName = "";
    clearOcrDisplay(); // 重要な変更点：保存が完了したら画像とステータスをクリア
    await updateFileListDisplay(); // ファイルリストを更新
}


// --- LLMリクエスト共通関数 (翻訳・回答生成で再利用) ---
async function performLlmRequest(modelSelect, llmPrompt, apiKey, onChunk = null, imageData = null) {
    let result = '';
    let endpoint = '';
    let bodyData = {};
    let isStreaming = false;
    
    const isGeminiCloudModel = modelSelect.toLowerCase().startsWith('gemini');
    const isSarasinaModel = modelSelect.toLowerCase().includes('sarasina');
    
    if (isGeminiCloudModel) {
        // --- Gemini Cloud Model ---
        if (!apiKey) throw new Error("Gemini API Key is required.");

        // 利用可能な最新かつ安定したモデルエイリアスのみに絞り込みます
        const candidates = [
        'gemini-2.5-flash',      // 最新の安定版（メイン利用に推奨）
        'gemini-2.5-flash-lite', // 軽量・高速版（コスト効率重視）
        'gemini-1.5-flash'       // 以前の安定版（予備として）
        ];

        let success = false;
        let lastError = null;

        for (const modelVersion of candidates) {
            try {
                console.log(`Trying Gemini model: ${modelVersion}`);
                const currentEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelVersion}:generateContent?key=${apiKey}`;
                const currentBody = {
                    contents: [{ 
                        parts: [
                            { text: llmPrompt },
                            ...(imageData ? [{ inline_data: { mime_type: "image/jpeg", data: imageData.split(',')[1] } }] : [])
                        ] 
                    }],
                    generationConfig: { temperature: 0.1 }
                };

                const response = await fetch(currentEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentBody)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 404 || response.status === 503) {
                        lastError = new Error(`Gemini API Error (${response.status}): ${errorText}`);
                        continue;
                    }
                    if (response.status === 400 || response.status === 403) {
                        localStorage.removeItem('plowerGeminiApiKey');
                        throw new Error(`Gemini API Auth Error (${response.status}): ${errorText}`);
                    }
                    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
                }

                const json = await response.json();
                if (json.candidates && json.candidates[0].content) {
                    result = json.candidates[0].content.parts.map(p => p.text).join('');
                    success = true;
                    break; 
                } else {
                    throw new Error(`Unexpected response format from ${modelVersion}`);
                }
            } catch (e) {
                lastError = e;
                console.error(`Error with model ${modelVersion}:`, e);
            }
        }

        if (!success) throw lastError || new Error('All Gemini candidates failed.');
        if (onChunk) onChunk(result);
        return result;

    } else if (isSarasinaModel) {
        // --- Sarasina Model ---
        endpoint = 'http://localhost:8001/api/sarasina';
        bodyData = { model: modelSelect, prompt: llmPrompt, temperature: 0.1 };
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (!response.ok) throw new Error(`Sarasina Error: ${response.statusText}`);
        const json = await response.json();
        result = String(json.response || (typeof json.detail === 'object' ? JSON.stringify(json.detail) : json.detail) || "");
        if (onChunk) onChunk(result);
        return result;

    } else if (modelSelect.startsWith('webgpu')) {
        // --- WebGPU+WASM Offline Capsule ---
        const specificModelId = modelSelect.split(':')[1];
        const hfToken = localStorage.getItem('plowerHfToken');

        // P2P分散コンピューティングの拡張点（Cloudflareシグナリング）
        // 現在はローカルのWeb Workerと直結していますが、この通信をWebSocketに切り替えることで
        // 別端末のブラウザ（GPU）で推論させることも可能になります。
        if (!window.capsuleWorker) {
            window.capsuleWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        }
        
        return new Promise((resolve, reject) => {
            let lastOutput = '';
            const onMessage = (e) => {
                const { status, output, error, tokenCount, elapsed, maxTokens, modelId, warning } = e.data;
                if (status === 'error') {
                    window.capsuleWorker.removeEventListener('message', onMessage);
                    reject(new Error(error));
                } else if (status === 'chunk') {
                    lastOutput = output;
                    if (onChunk) onChunk(output, { tokenCount, elapsed, maxTokens, warning });
                } else if (status === 'heartbeat') {
                    if (onChunk) {
                        let display = lastOutput + `\n\n<span style="color:#888; font-size:0.85em;">[CPU推論中... 応答を待っています (${elapsed}秒経過)]</span>`;
                        onChunk(display);
                    }
                } else if (status === 'complete') {
                    window.capsuleWorker.removeEventListener('message', onMessage);
                    resolve(output);
                } else if (status === 'auth_error') {
                    // 認証エラー時はダイアログを出してトークン入力を待ち、その後再送する
                    showAuthDialog(modelId, error).then(newToken => {
                        localStorage.setItem('plowerHfToken', newToken);
                        const hfInput = document.getElementById('hfToken');
                        if (hfInput) hfInput.value = newToken;
                        
                        window.capsuleWorker.postMessage({ 
                            type: 'generate', 
                            prompt: llmPrompt, 
                            image: imageData, 
                            modelId: specificModelId,
                            token: newToken
                        });
                    }).catch(() => {
                        window.capsuleWorker.removeEventListener('message', onMessage);
                        reject(new Error(isEn ? `Access denied: ${error || 'User cancelled'}` : `アクセス拒否: ${error || 'キャンセルされました'}`));
                    });
                } else if (status === 'loading') {
                    lastOutput = `[WASM/WebGPU: ${output}]`;
                    if (onChunk) onChunk(lastOutput);
                }
            };
            window.capsuleWorker.addEventListener('message', onMessage);
            window.capsuleWorker.postMessage({ 
                type: 'generate', 
                prompt: llmPrompt, 
                image: imageData, 
                modelId: specificModelId,
                token: hfToken
            });
        });

    } else {
        // --- Ollama / Local AI Model ---
        const hfUrl = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
        const isLocalHost = hfUrl.includes('localhost') || hfUrl.includes('127.0.0.1');

        // HTTPS環境で localhost にアクセスしようとする場合、自動で Sagbiブリッジ(WebSocket)に切り替える
        if (isHttpsOrigin && isLocalHost) {
            console.log("[Bridge] Routing request via Sagbi Bridge (WebSocket)...");
            return await fetchViaSagbiBridge(modelSelect, llmPrompt, imageData, onChunk);
        }

        // 通常の HTTP 直接接続
        let endpoint = hfUrl.endsWith('/') ? hfUrl.slice(0, -1) : hfUrl;
        endpoint = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

        bodyData = {
            model: modelSelect,
            prompt: llmPrompt,
            stream: true,
            images: imageData ? [imageData.split(',')[1]] : undefined,
            options: { temperature: 0.1, num_ctx: 4096 } // CPUリソースに合わせてコンテキスト窓を調整
        };

        return await fetchOllamaStream(endpoint, bodyData, onChunk);
    }
}

/**
 * WebSocketブリッジ経由で推論リクエストを送信
 */
async function fetchViaSagbiBridge(model, prompt, image, onChunk) {
    if (!sagbiSocket || sagbiSocket.readyState !== WebSocket.OPEN) {
        throw new Error("Sagbi Bridge is not connected. Make sure your local server is running and Cloudflare Tunnel is active.");
    }

    const requestId = "plower-" + crypto.randomUUID();
    return new Promise((resolve, reject) => {
        pendingLlmResolves.set(requestId, { resolve, reject, onChunk, result: "" });
        
        sagbiSocket.send(JSON.stringify({
            type: 'chat_message',
            payload: { id: requestId, model, text: prompt, image: image?.split(',')[1] }
        }));
    });
}

// Ollamaストリーミング処理のヘルパー
async function fetchOllamaStream(endpoint, bodyData, onChunk) {
    let result = '';
    const hfToken = localStorage.getItem('plowerHfToken');
    const headers = { 'Content-Type': 'application/json' };
    
    // Hugging Face Space等へのアクセス用に認証トークンを付与
    if (hfToken) {
        headers['Authorization'] = `Bearer ${hfToken}`;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyData)
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
         throw new Error("Server returned HTML. Check URL or Space status.");
    }

    if (!response.ok) {
        if (response.status === 404) throw new Error(`Model '${bodyData.model}' not found.`);
        if (response.status === 403) throw new Error(`Access Forbidden (403). Check Hugging Face Token or OLLAMA_ORIGINS.`);
        throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) throw new Error("No response body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        chunk.trim().split('\n').forEach(line => {
            if (line) {
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        result += json.response;
                        if (onChunk) onChunk(result);
                    }
                } catch (e) {}
            }
        });
    }
    return result;
}

// --- モデル送信ロジック ---
let isSending = false; // 多重送信防止フラグ

async function sendToModel() {
    // 多重送信を防止: 既にリクエスト中なら何もしない
    if (isSending) return;

    const userInputElement = document.getElementById('userInput');
    const userInput = userInputElement.value.trim();
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    const chatLog = document.getElementById('chatLog');
    const sendButton = document.getElementById('sendButton');
    const modelSelect = document.getElementById('modelSelect').value;
    const geminiApiKey = document.getElementById('geminiApiKey').value.trim();

    if (!userInput) {
        alert(isEn ? "Please enter a question." : "質問を入力してください。");
        return;
    }

    isSending = true;
    sendButton.disabled = true;
    sendButton.textContent = isEn ? 'Sending...' : '送信中...';

    const questionParagraph = document.createElement('p');
    questionParagraph.innerHTML = `<strong>${isEn ? 'Question' : '質問'}:</strong> ${esc(userInput)}`;
    chatLog.appendChild(questionParagraph);

    const responseParagraph = document.createElement('p');
    responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> (${isEn ? 'Processing...' : '処理中...'})`;
    chatLog.appendChild(responseParagraph);

    // 全てのRAGソースを統合
    let allDocuments = [...persistentDocuments];
    if (pasteAreaContent) {
        // 貼り付けエリアのテキストは一時文書として扱う
        allDocuments.push({ name: '貼付けテキスト(一時)', content: pasteAreaContent });
    }
    
    // --- フロントエンドでの検索処理を廃止 ---
    
    // 質問文から言語を判定し、システムプロンプトを切り替える
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(userInput);
    const detectedIsEn = !hasJapanese;
    
    // 言語が変わった場合、またはキャッシュがない場合はプロンプトをリロード
    if (detectedIsEn !== isEn || !systemPromptCache) {
        isEn = detectedIsEn;
        await loadSystemPrompt(isEn ? 'en' : 'ja');
    }

    const languageSuffix = isEn 
        ? "\n\nImportant: Please answer in English."
        : "\n\n重要: 回答は必ず日本語で行ってください。資料が英語であっても、日本語で詳しく説明してください。";

    // 質問内容に関連するファイルを優先的にコンテキストに含めるためのソート
    const prioritizedDocs = [...allDocuments].sort((a, b) => {
        const aMentioned = userInput.toLowerCase().includes(a.name.toLowerCase());
        const bMentioned = userInput.toLowerCase().includes(b.name.toLowerCase());
        if (aMentioned && !bMentioned) return -1;
        if (!aMentioned && bMentioned) return 1;
        return 0;
    });
    
    let imageDataToSend = currentImageBase64;

    // 文書リストからテキストコンテキストを作成。
    // 画像データ（Base64文字列）が混ざるとプロンプトが巨大になり、AIが混乱するため、[Image Data]というラベルに置き換える。
    let contextParts = [];
    for (const docMeta of prioritizedDocs) {
        let content = "";
        // 「貼付けテキスト(一時)」の場合はOPFSではなく、docMeta自身が持っているcontentを使用する
        if (docMeta.content !== undefined) {
            content = docMeta.content;
        } else {
            content = await getDocumentContent(docMeta.name);
        }

        if (content.startsWith('data:image/')) {
            // 質問の中でファイル名が言及されている画像を優先的にVision入力として選択
            const isMentioned = userInput.toLowerCase().includes(docMeta.name.toLowerCase()) || 
                               userInput.toLowerCase().includes(docMeta.name.split('.')[0].toLowerCase());
            if (isMentioned) {
                imageDataToSend = content;
            }
            contextParts.push(`File: ${docMeta.name}\nContent: [Image Data (Vision Input)]`);
        } else {
            contextParts.push(`File: ${docMeta.name}\nContent: ${content}`);
        }
    }
    let context = contextParts.join('\n\n');
    
    const isCpuCapsule = modelSelect.startsWith('webgpu');
    const isGpt2 = modelSelect.includes('gpt2');

    // GPT-2: 物理的な上限が1024トークンと非常に小さいため、日本語では数百文字が限界。
    // 他のWebGPUモデル(Qwen/Llama)もブラウザのメモリ節約のため、適度に制限。
    const maxContextChars = isGpt2 ? 500 : (isCpuCapsule ? 2500 : 15000);

    context = context.slice(0, maxContextChars);

    // UIステータス表示の改善（回答エリアの初期化）
    responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> <span class="status-msg">${isEn ? 'Thinking...' : '思考中...'}</span>`;

    const systemPrompt = systemPromptCache || "You are a world-class coding assistant.";

    // プロンプトの生成: LlamaやQwenなど高性能モデル用に詳細な指示を含める
    // 指示が多すぎると軽量モデル(Qwen 0.5B)が混乱するため、構造を簡潔にします
    let prompt;
    if (isGpt2) {
        // GPT-2(Baseモデル)用のシンプルなプロンプト。
        prompt = `${systemPrompt}${languageSuffix}\n\nContext: ${context}\n\nQuestion: ${userInput}\n\nAnswer:`;
    } else {
        // Qwen 0.5B 用: 余計な指示を削り、検索結果をそのまま出させる「抽出モード」
        prompt = `${systemPrompt}${languageSuffix}

Context:
${context}

Question: ${userInput}

Instruction: Please answer based on the provided documents. If the information is not present, use your technical knowledge as a coding assistant to provide the best possible response.
Answer:`;
    }
    
    // スクロールを最下部へ移動させるヘルパー
    const scrollToBottom = () => {
        // ユーザーが手動で上にスクロールしている場合は自動スクロールしない
        const isNearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 200;
        if (isNearBottom) {
            document.body.style.paddingBottom = "50vh"; // 適度な余白
            responseParagraph.scrollIntoView({ behavior: 'auto', block: 'end' });
        }

        // requestAnimationFrameでレンダリング後の位置を微調整
        requestAnimationFrame(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
        });
    };

    // --- 回答生成 ---
    try {
        // 共通関数を使ってリクエスト
        const finalResult = await performLlmRequest(modelSelect, prompt, geminiApiKey, (chunkText, meta = {}) => {
            // ストリーミング更新
            const warningHtml = meta.warning ? `<div style="color:#d32f2f; background:#fff1f0; padding:8px; border-radius:4px; margin-bottom:8px; font-size:0.9em; border:1px solid #ffa39e;">${meta.warning.replace(/\n/g, '<br>')}</div>` : "";
            
            let metaHtml = "";
            if (meta.tokenCount !== undefined) {
                metaHtml = `<br><small style="color:#888;">[${isEn ? 'CPU Inferring' : 'CPU推論中'}: ${meta.tokenCount}/${meta.maxTokens} (${meta.elapsed}s)]</small>`;
            } else if (isCpuCapsule && !meta.warning) {
                metaHtml = `<br><small style="color:#888;">[${isEn ? 'WASM/CPU Inference' : 'WASM/CPU推論実行中'}]</small>`;
            }
            responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong><br>${warningHtml}${esc(chunkText).replace(/\n/g, '<br>')}<div style="height:10px;"></div>${metaHtml}`;
            scrollToBottom();
        }, imageDataToSend);

        // 最終結果の表示 (非ストリーミングモデル用)
        const warningHtmlFinal = responseParagraph.querySelector('div[style*="color:#d32f2f"]') ? responseParagraph.querySelector('div[style*="color:#d32f2f"]').outerHTML : "";
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong><br>${warningHtmlFinal}${esc(finalResult).replace(/\n/g, '<br>')}`;
        
        // 「RAGソースに加える」ボタンの追加
        const saveChatBtn = document.createElement('button');
        saveChatBtn.textContent = isEn ? 'Add to RAG Source' : 'RAGソースに加える';
        saveChatBtn.style.marginTop = '10px';
        saveChatBtn.style.display = 'block';
        saveChatBtn.onclick = async () => {
            const chatContent = `Question: ${userInput}\n\nAnswer: ${finalResult}`;
            const now = new Date();
            const pad = (num) => num.toString().padStart(2, '0');
            const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const defaultName = `chat_memo_${timestamp}.txt`;

            const filename = await showRenameDialog(isEn ? 'Save Chat to RAG' : 'チャットをRAGソースに保存', defaultName);
            if (!filename) return;

            // OPFSへの保存
            await saveDocumentToOPFS(filename, chatContent);
            if (!persistentDocuments.some(d => d.name === filename)) {
                persistentDocuments.push({ name: filename });
            }

            // ローカルフォルダ同期が有効ならそちらにも保存
            if (directoryHandle) {
                const blob = new Blob([chatContent], { type: 'text/plain;charset=utf-8' });
                await saveBlobToDirectory(blob, filename);
            }

            await updateFileListDisplay();
            saveChatBtn.textContent = isEn ? 'Added to RAG' : 'RAGに追加済み';
            saveChatBtn.disabled = true;
        };
        responseParagraph.appendChild(saveChatBtn);

        // 画像を解析に使用した場合、保存を提案する
        if (currentImageBase64) {
            const savePrompt = document.createElement('div');
            savePrompt.style.marginTop = '15px';
            savePrompt.style.padding = '10px';
            savePrompt.style.border = '1px dashed #ccc';
            savePrompt.innerHTML = `<p style="margin:0 0 10px 0; font-size:0.9em;">${isEn ? 'Analysis used an image. Save it locally?' : '画像を解析に使用しました。この画像をローカルに保存しますか？'}</p>`;
            
            const dlBtn = document.createElement('button');
            dlBtn.textContent = isEn ? 'Save as JPG' : '画像をJPGで保存';
            const imgDataToSave = currentImageBase64;
            dlBtn.onclick = () => {
                const link = document.createElement('a');
                link.href = imgDataToSave;
                link.download = `plower_analyzed_${Date.now()}.jpg`;
                link.click();
            };
            savePrompt.appendChild(dlBtn);
            responseParagraph.appendChild(savePrompt);
            // 解析が終わったら画像キャッシュをクリア（次の質問で画像を使わないため）
            currentImageBase64 = null;
            currentImageBlob = null;
            currentImageName = "";
        }
        
        userInputElement.value = ''; // 質問欄をクリア

    } catch (error) {
        // 生のエラーメッセージのみを先にエスケープする
        let safeErrorBase = esc(error.message);
        let errorHint = "";

        // HTTPS環境からHTTP(ローカル)へ接続しようとして失敗した場合のヒントを追加
        const isNetworkError = error.name === 'TypeError' || error.message.toLowerCase().includes('fetch') || error.message.toLowerCase().includes('network');
        const hfUrl = localStorage.getItem('plowerHfUrl') || "";
        const isLocalRequest = hfUrl.includes('localhost') || hfUrl.includes('127.0.0.1') || !hfUrl;
        if (isNetworkError) {
            if (window.location.protocol === 'file:') {
                errorHint = isEn 
                    ? "<br>⚠️ <strong>Security Restriction:</strong> You cannot make API requests when opening the file directly (file://). Please use a local server like VS Code's 'Live Server'."
                    : "<br>⚠️ <strong>セキュリティ制限:</strong> ファイルを直接ブラウザで開いている(file://)ため、APIリクエストが遮断されました。VS CodeのLive Serverを使用するか、'npx serve' 等のローカルサーバー経由で開いてください。";
            } else if (isHttpsOrigin && isLocalRequest) {
                errorHint = isEn 
                    ? "<br>⚠️ <strong>Mixed Content Error:</strong> You are accessing Plower via HTTPS, but trying to connect to a local HTTP server. Browsers block this for security. <br><strong>Solution:</strong> Use the local version at <code>http://localhost:5173</code> instead of the public URL."
                    : "<br>⚠️ <strong>セキュリティ制限（混合コンテンツ）:</strong> HTTPSのサイトからローカルのHTTPサーバー（Ollama等）へは接続できません。<br><strong>解決策:</strong> 公開URLではなく、ローカルの <code>http://localhost:5173</code> 等からアプリを開いてください。";
            } else if (isLocalRequest) {
                errorHint = isEn
                    ? "<br>⚠️ <strong>CORS / Connection Error:</strong> Cannot reach Ollama. <br><strong>Solution:</strong> Ensure Ollama is running and set environment variable: <code>OLLAMA_ORIGINS=\"*\"</code>"
                    : "<br>⚠️ <strong>接続エラー / CORS制限:</strong> ローカルのAIサーバーに接続できません。<br><strong>解決策:</strong> Ollamaが起動しているか確認し、環境変数 <code>OLLAMA_ORIGINS=\"*\"</code> を設定して再起動してください。";
            }
        }

        if (safeErrorBase.includes('容量不足') || safeErrorBase.includes('Quota') || safeErrorBase.includes('DEVICE_SPACE')) {
            errorHint += `<br><br>⚠️ <strong>ストレージの問題を検出しました:</strong><br>`;
            errorHint += isEn 
                ? `Please check the <a href="manual.html" style="color:#d32f2f; font-weight:bold; text-decoration:underline;">Troubleshooting Guide</a>.`
                : `解決方法については、こちらの <a href="manual.html" style="color:#d32f2f; font-weight:bold; text-decoration:underline;">[使い方説明書/トラブルシューティング]</a> を確認してください。`;
        }

        if (safeErrorBase.includes('アクセス拒否') || safeErrorBase.includes('Access denied') || safeErrorBase.includes('403') || safeErrorBase.includes('forbidden')) {
            errorHint += `<br><br>💡 <strong>アクセス拒否の可能性があります:</strong><br>`;
            errorHint += isEn 
                ? `1. Gated model needs license agreement on HF.<br>2. Token scope might be insufficient.<br>3. Network/Proxy is blocking the request.<br>4. If "Downloaded" but failed, check memory (OOM).<br>`
                : `1. 制限付きモデルの場合、HF公式サイトでの規約同意が必要です。<br>2. 入力したトークンの権限（Scope）が不足している可能性があります。<br>3. ネットワークやプロキシによって通信が遮断されている可能性があります。<br>4. ダウンロード済みなのに拒否される場合、メモリ不足の可能性があります。<br>`;
            errorHint += `<br>👉 <a href="manual.html" style="color:#d32f2f; font-weight:bold; text-decoration:underline;">[${isEn ? 'Troubleshooting' : '解決方法を確認する'}]</a>`;
        }

        if (isNetworkError) {
            if (window.location.protocol === 'file:') {
                errorHint += isEn 
                    ? "<br>⚠️ <strong>Security Restriction:</strong> You cannot make API requests when opening the file directly (file://). Please use a local server."
                    : "<br>⚠️ <strong>セキュリティ制限:</strong> ファイルを直接ブラウザで開いている(file://)ため、APIリクエストが遮断されました。VS CodeのLive Serverを使用するか、'npx serve' 等のローカルサーバー経由で開いてください。";
            } else {
                errorHint += isEn 
                    ? "<br>⚠️ Request Blocked: Check your Internet connection and API Token. If using Gemma 3, make sure you've accepted the license on the Hugging Face model page."
                    : "<br>⚠️ リクエストが遮断されました: トークンの権限、ネット接続、広告ブロックを確認してください。Gemma 3を使用する場合、HFのモデルページでライセンスへの同意が必要です。";
            }
            errorHint += `<br><small>Debug Info: ${esc(error.name)} - ${safeErrorBase}</small>`;
        }

        if (safeErrorBase.includes('Module.MountedFiles is not available')) {
            errorHint += `<br><br>💡 <strong>ファイルシステムアクセスエラーの可能性があります:</strong><br>`;
            errorHint += isEn 
                ? `Space is sufficient, but the browser blocked OPFS. SharedArrayBuffer is likely disabled. The app will now try to auto-fix this with a Service Worker.`
                : `容量は十分（${document.getElementById('storageInfo')?.textContent || '50GB+'}）ですが、ブラウザが仮想ディスクの作成を拒否しました。<br><br>
                   <strong>重要な対策:</strong><br>
                   1. 現在 <code>localhost</code> を使用していますが、<strong>セキュリティヘッダー(COOP/COEP)</strong>が不足しています。<br>
                   2. ページを一度リロード（F5）してください。自動適用を試みます。<br>
                   3. シークレットモードを解除してください。<br>`;
            errorHint += `<br>👉 <button onclick="clearWebGpuModelCache()" style="background:#d32f2f; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; margin-top:5px;">${isEn ? 'Clear WebGPU Cache Now' : '今すぐWebGPUキャッシュをクリアする'}</button>`;
        }
        // HTMLタグ（errorHint）をエスケープせずに結合して表示
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ❌ ${isEn ? 'Error occurred' : 'エラーが発生しました'}: ${safeErrorBase}${errorHint}`;
        console.error("Model request error:", error);
    } finally {
        isSending = false;
        sendButton.disabled = false;
        sendButton.textContent = isEn ? 'Send' : '送信';
        // 完了時に再度確実にスクロール
        setTimeout(scrollToBottom, 150);
    }
}

// --- 初期化とイベントリスナー設定 ---
document.addEventListener('DOMContentLoaded', () => {
    // --- Cross-Origin Isolation (COOP/COEP) 活性化用 Service Worker ---
    // これがないと localhost でも Gemma 2 (WASM/OPFS) は動作しません。
    if ('serviceWorker' in navigator && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).then(registration => {
            registration.onupdatefound = () => {
                const installingWorker = registration.installing;
                installingWorker.onstatechange = () => {
                    if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
                        console.log("[Storage] Security headers applied via SW. Reloading for activation...");
                        location.reload();
                    }
                };
            };
            
            // 初回登録時かつ隔離されていない場合はリロード
            if (!window.crossOriginIsolated && !navigator.serviceWorker.controller) {
                console.log("[Storage] Registering security polyfill...");
                setTimeout(() => location.reload(), 500);
            }
        }).catch(err => {
            console.error("SW Registration failed:", err);
            if (err.name === 'SecurityError' || err.message.includes('scheme')) {
                console.warn("Browser blocked Blob-based Service Worker. Trying to fallback to physical 'sw.js' if available...");
                // 物理ファイルとしての sw.js がルートにある場合はそちらを試みる
                navigator.serviceWorker.register('./sw.js').catch(() => {
                    console.error("Physical sw.js also not found. Cross-Origin Isolation cannot be enabled automatically.");
                });
            }
        });
    }

    // ストレージの永続化をリクエスト
    if (navigator.storage && navigator.storage.persist) {
        const requestPersist = async () => {
            const granted = await navigator.storage.persist();
            if (granted) {
                console.log("[Storage] Persistent storage granted.");
                loadDocuments(); // 表示を更新
            }
        };
        
        // 自動リクエスト
        requestPersist();

        // ユーザーがUIを触ったときにもう一度リクエスト（ブラウザはユーザー操作に伴うリクエストを承認しやすいため）
        document.addEventListener('click', async () => {
            if (navigator.storage && navigator.storage.persisted) {
                const isAlreadyPersisted = await navigator.storage.persisted();
                if (!isAlreadyPersisted) requestPersist();
            }
        }, { once: true });
    }

    // --- ブックマークレットのURLを現在の環境（localhostか公開URLか）に合わせて動的に更新 ---
    const bookmarkletLink = document.getElementById('bookmarkletLink');
    if (bookmarkletLink) {
        const currentUrl = window.location.origin + window.location.pathname;
        // ブックマークレット内の 'u' (URL) を現在のURLに差し替える
        const bookmarkletCode = `javascript:(function(){
            const u='${currentUrl}';
            const n='plower_popup';
            const w=window.open(u, n, 'width=500,height=900');
            const send=()=>{
                w.postMessage({
                    type:'PLOWER_INJECT_CONTENT',
                    name:'Page: '+document.title.substring(0,30)+'.txt',
                    content:'URL: '+window.location.href+'\\n\\n'+document.body.innerText
                },'*');
            };
            window.addEventListener('message', function listener(e){
                if(e.data==='PLOWER_READY'){ send(); window.removeEventListener('message', listener); }
            });
            /* 念のための予備送信 */
            setTimeout(send, 3000);
            if(window.focus)w.focus();
        })();`.replace(/\s+/g, ' ');
        bookmarkletLink.href = bookmarkletCode;
    }

    // --- イベントリスナーの登録 (失敗しても後続に影響しないよう前方に配置) ---
    const clearWebGpuBtn = document.getElementById('clearWebGpuCacheButton');
    if (clearWebGpuBtn) {
        clearWebGpuBtn.addEventListener('click', clearWebGpuModelCache);
    }

    document.getElementById('sendButton').addEventListener('click', sendToModel);
    document.getElementById('resetDocsButton').addEventListener('click', resetDocuments);
    document.getElementById('saveOcrButton').addEventListener('click', saveOcrTextAsFile);
    document.getElementById('syncFolderButton').addEventListener('click', syncLocalFolder);
    
    // --- Sagbiブリッジ接続の初期化 ---
    const connectBridge = () => {
        const url = getSignalingUrl();
        const ws = new WebSocket(url);
        sagbiSocket = ws;

        ws.onopen = () => {
            console.log("[Bridge] Connected to Sagbi mesh.");
            ws.send(JSON.stringify({ type: 'register', payload: { role: 'user' } }));
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'chat_response') {
                let payload = msg.payload;
                // GoサーバーからペイロードがJSON文字列として送られてくる場合のパース処理を追加
                if (typeof payload === 'string' && payload.startsWith('{')) {
                    try { payload = JSON.parse(payload); } catch (e) {}
                }

                const { id: payloadId, text, done } = payload;
                // IDの抽出元を拡張し、無い場合は保留中のリクエストが1つならそれを救済
                let id = payloadId || msg.id;
                
                // マップに直接存在しない場合（prefix違いなど）の救済
                if (id && !pendingLlmResolves.has(id)) {
                    if (id.startsWith('ai-') && pendingLlmResolves.has(id.substring(3))) {
                        id = id.substring(3);
                    } else if (pendingLlmResolves.size === 1) {
                        id = pendingLlmResolves.keys().next().value;
                    }
                } else if (!id && pendingLlmResolves.size === 1) {
                    id = pendingLlmResolves.keys().next().value;
                }

                const pending = pendingLlmResolves.get(id);
                if (pending) {
                    if (text !== undefined) {
                        pending.result = text;
                        if (pending.onChunk) pending.onChunk(pending.result);
                    }
                    if (done) {
                        pending.resolve(pending.result);
                        pendingLlmResolves.delete(id);
                    }
                }
            }
        };

        ws.onclose = () => {
            console.warn("[Bridge] Connection closed. Retrying...");
            setTimeout(connectBridge, 3000);
        };

        ws.onerror = (e) => console.error("[Bridge] WebSocket Error:", e);
    };

    // 公開URL(HTTPS)での実行時、またはローカル開発中にブリッジを有効化
    connectBridge();


    // --- P2Pブリッジ (WebRTC) の準備 ---
    // P2Pモードが有効な場合、バックグラウンドの terminal_receiver.js と接続を試みます。
    if (localStorage.getItem('plowerUseP2P') === 'true') setupP2PBridge();

    // APIキーのロードと保存処理
    const savedKey = localStorage.getItem('plowerGeminiApiKey');
    if (savedKey) {
        document.getElementById('geminiApiKey').value = savedKey;
    }
    
    const saveKeyBtn = document.getElementById('saveKeyButton');
    saveKeyBtn.addEventListener('click', () => {
        const key = document.getElementById('geminiApiKey').value.trim();
        if (key) {
            localStorage.setItem('plowerGeminiApiKey', key);
            alert(isEn ? 'Gemini API Key saved.' : 'Gemini APIキーを保存しました。次回から自動入力されます。');
        } else {
            alert(isEn ? 'Key is empty. Use "Delete Key" button to remove it.' : 'キーが空です。削除する場合は「キー削除」ボタンを使用してください。');
        }
    });

    // 削除ボタンを動的に追加
    const deleteKeyBtn = document.createElement('button');
    deleteKeyBtn.textContent = isEn ? 'Delete Key' : 'キー削除';
    deleteKeyBtn.style.marginLeft = '5px';
    deleteKeyBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerGeminiApiKey');
        document.getElementById('geminiApiKey').value = '';
        alert(isEn ? 'Gemini API Key deleted.' : '保存されたGemini APIキーを削除しました。');
    });
    saveKeyBtn.parentNode.insertBefore(deleteKeyBtn, saveKeyBtn.nextSibling);
    
    // --- Hugging Face Access Token のロードと保存処理 ---
    const savedHfToken = localStorage.getItem('plowerHfToken');
    if (savedHfToken) {
        document.getElementById('hfToken').value = savedHfToken;
    }

    const saveHfTokenBtn = document.getElementById('saveHfTokenButton');
    if (saveHfTokenBtn) {
        saveHfTokenBtn.addEventListener('click', () => {
            const token = document.getElementById('hfToken').value.trim();
            if (token) {
                localStorage.setItem('plowerHfToken', token);
                alert(isEn ? 'HuggingFace Token saved.' : 'HuggingFaceトークンを保存しました。');
            } else {
                alert(isEn ? 'Token is empty. Use "Delete Token" button to remove it.' : 'トークンが空です。削除する場合は「トークン削除」ボタンを使用してください。');
            }
        });

        // トークン削除ボタンの追加
        const deleteHfTokenBtn = document.createElement('button');
        deleteHfTokenBtn.textContent = isEn ? 'Delete Token' : 'トークン削除';
        deleteHfTokenBtn.style.marginLeft = '5px';
        deleteHfTokenBtn.addEventListener('click', () => {
            localStorage.removeItem('plowerHfToken');
            document.getElementById('hfToken').value = '';
            alert(isEn ? 'HuggingFace Token deleted.' : '保存されたHuggingFaceトークンを削除しました。');
        });
        saveHfTokenBtn.parentNode.insertBefore(deleteHfTokenBtn, saveHfTokenBtn.nextSibling);
    }

    // --- HuggingFace URL設定の初期化とイベントリスナー ---
    const hfUrlInput = document.getElementById('hfUrlInput');
    if (hfUrlInput) {
        hfUrlInput.value = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
    }

    const saveHfUrlBtn = document.getElementById('saveHfUrlButton');
    saveHfUrlBtn.addEventListener('click', () => {
        let url = hfUrlInput.value.trim();
        if (!url) url = 'http://localhost:11434';
        let finalMessage = isEn ? 'HuggingFace URL saved.' : 'HuggingFaceのURL設定を保存しました。';
        
        // Hugging Face SpacesのWeb URLが入力された場合、Direct URLに自動変換する
        // 例: https://huggingface.co/spaces/username/spacename -> https://username-spacename.hf.space
        const hfMatch = url.match(/^https?:\/\/huggingface\.co\/spaces\/([^\/]+)\/([^\/]+)\/?$/);
        if (hfMatch) {
            const username = hfMatch[1].toLowerCase();
            const spacename = hfMatch[2].toLowerCase();
            url = `https://${username}-${spacename}.hf.space`;
            hfUrlInput.value = url; // 入力欄も更新
            finalMessage = isEn ? 'Converted Hugging Face Space URL to Direct URL format and saved.' : 'Hugging Face SpaceのWeb URLを検出し、API用のDirect URL形式に自動変換して保存しました。';
        }
        
        localStorage.setItem('plowerHfUrl', url);
        alert(finalMessage);
    });

    // HuggingFace URL削除ボタンを動的に追加
    const deleteHfUrlBtn = document.createElement('button');
    deleteHfUrlBtn.textContent = isEn ? 'Delete URL' : 'URL削除';
    deleteHfUrlBtn.style.marginLeft = '5px';
    deleteHfUrlBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerHfUrl');
        if (hfUrlInput) hfUrlInput.value = 'http://localhost:11434';
        alert(isEn ? 'Saved URL deleted (Reset to default).' : '保存されたURL設定を削除しました（デフォルトのlocalhostに戻りました）。');
    });
    saveHfUrlBtn.parentNode.insertBefore(deleteHfUrlBtn, saveHfUrlBtn.nextSibling);

    // Enterキーでの送信機能 (keydownを使用し、リピート入力とShift+Enterを除外)
    document.getElementById('userInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !isSending) {
            e.preventDefault();
            sendToModel();
        }
    });

    // DOMロード後にイベントリスナーを登録 (安全策)
    const pasteArea = document.getElementById('pasteArea');
    if (pasteArea) pasteArea.addEventListener('paste', handlePaste);

    // 非同期データの読み込みを開始
    loadDocuments(); 
    loadSystemPrompt(); 

    // --- ブックマークレット連携用: 外部サイトからのコンテンツ注入リスナー ---
    window.addEventListener('message', async (event) => {
        // セキュリティ上の配慮が必要な場合は event.origin をチェックしてください
        if (event.data && event.data.type === 'PLOWER_INJECT_CONTENT') {
            const { name, content } = event.data;
            if (name && content) {
                await saveDocumentToOPFS(name, content);
                if (!persistentDocuments.some(d => d.name === name)) {
                    persistentDocuments.push({ name: name });
                }
                await updateFileListDisplay();
            }
        }
    });

    // ブックマークレット連携用: ポップアップ元のページに対して準備完了を通知
    if (window.opener) {
        window.opener.postMessage('PLOWER_READY', '*');
    }
});

/**
 * P2Pブリッジ (WebRTC) のシグナリングと接続確立
 * これにより、HTTPS環境からでもローカルのAIリソースを安全に使用可能になります。
 */
async function setupP2PBridge() {
    const hfUrl = localStorage.getItem('plowerHfUrl') || 'http://localhost:8080';
    // URLをWebSocket形式に変換
    const wsUrl = hfUrl.replace(/^http/, 'ws') + '/ws';
    
    console.log(`[P2P] Attempting bridge signaling via: ${wsUrl}`);
    
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const dc = pc.createDataChannel("plower_llm_bridge");
    
    dc.onopen = () => console.log("[P2P] Bridge Established! You can now bypass Mixed Content restrictions.");
    dc.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        // 受信したLLMレスポンスをチャットに反映する等の処理
        console.log("[P2P] Message from local bridge:", msg);
    };

    // シグナリングサーバー（Go）経由でSDPを交換するロジックをここに記述
    // 現時点では skeleton（骨組み）のみ。
    window.p2pBridgeChannel = dc;
}

/**
 * P2Pブリッジ経由でリクエストを送るためのラップ関数
 */
async function fetchViaP2P(bodyData) {
    if (!window.p2pBridgeChannel || window.p2pBridgeChannel.readyState !== 'open') {
        throw new Error("P2P Bridge not ready.");
    }
    return new Promise((resolve) => {
        const requestId = Date.now().toString();
        const timeout = setTimeout(() => resolve({ error: "P2P Timeout" }), 30000);
        
        window.p2pBridgeChannel.send(JSON.stringify({ id: requestId, ...bodyData }));
        // レシーバー側で処理が終わったら、requestIdを付けて結果を返してもらう
        // (実際にはメッセージハンドラで resolve を呼ぶための管理リストが必要)
    });
}