import { pipeline, env, RawImage, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// このWorkerファイルは、HTML/UI層とは完全に隔離された「AIカプセル」として動作します。
// WebGPUが使えない環境（Linuxの一部や未対応ブラウザ）では、自動的にCPU(WASM)にフォールバックします。

env.allowLocalModels = false;

// v3では、外部データファイル(.onnx_data)を持つモデル（Gemma 2 2B等）の読み込みに
// OPFS (Origin Private File System) が必須です。
// これを false にすると "Module.MountedFiles is not available" エラーが発生します。
env.useOriginPrivateFileSystem = true;

// Cache APIも併用可能。メタデータなどは標準キャッシュ、重いデータはOPFSという使い分けを許可する。
env.useBrowserCache = true;

const wasmPath = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/";

// v3 における環境設定の強制適用
const config = { wasmPaths: wasmPath, numThreads: 1, proxy: false };
env.wasm = Object.assign(env.wasm || {}, config);
env.backends = env.backends || {};
env.backends.onnx = env.backends.onnx || {};
env.backends.onnx.wasm = Object.assign(env.backends.onnx.wasm || {}, config);

// GPT-2 のモデル上限: positional embedding = 1024 tokens
const GPT2_MAX_POSITION = 1024;
// CPU推論のタイムアウト (90秒 — GPT-2 WASMは1トークン≒1-2秒かかるため)
const CPU_INFERENCE_TIMEOUT_MS = 6000000;

let generatorPromise = null;
let currentGeneratorModelId = null;
let lastToken = null;

async function initGenerator(task, modelId, device, token = null) {
    // Transformers.js v3 のグローバル設定にトークンを反映
    // これにより pipeline 内部の個別の fetch リクエストにもトークンが適用されます
    if (token) {
        env.token = token;
    }

    if (currentGeneratorModelId === modelId && lastToken === token && generatorPromise) {
        return generatorPromise;
    }

    // 別のモデルをロード済みの場合は、WASMメモリ解放のため可能であれば破棄(dispose)する
    if (generatorPromise) {
        try {
            const oldGen = await generatorPromise;
            if (typeof oldGen.dispose === 'function') oldGen.dispose();
        } catch (e) { }
    }

    currentGeneratorModelId = modelId;
        lastToken = token;

    // デバイスとモデルに応じた最適な型(dtype)を選択
    // Gemma 2 2Bなどは q4f16 でないと動作しないことが多いですが、
    // WebGPUが使えない(WASM)環境ではメモリ節約のため q4 を優先します。
    const isGemma2 = modelId.toLowerCase().includes('gemma-2');
    const selectedDtype = (device === 'webgpu' || isGemma2) ? 'q4f16' : 'q4';

    const options = {
        device: device,
        dtype: selectedDtype,
        token: token,
        progress_callback: (x) => {
            const file = x.file || '';
            if (x.status === 'cached') {
                // キャッシュに存在することを明示
                postMessage({ status: 'loading', output: `キャッシュを利用: ${file}` });
            } else if (x.status === 'initiate') {
                // 取得開始（ネットワーク確認中）
                postMessage({ status: 'loading', output: `リポジトリ確認中: ${file}` });
            } else if (x.status === 'download') {
                // 実際にネットワーク通信が発生している場合のみ「ダウンロード」と表現
                const isMetadata = file.endsWith('.json') || file.endsWith('.txt') || file.endsWith('.py');
                const label = isMetadata ? '設定をダウンロード中' : 'ネットワークから取得中';
                const progressStr = (typeof x.progress === 'number' && !isNaN(x.progress)) ? ` (${Math.round(x.progress)}%)` : '';
                postMessage({ status: 'loading', output: `${label}: ${file}${progressStr}` });
            } else if (x.status === 'done') {
                postMessage({ status: 'loading', output: `完了: ${file}` });
            } else if (x.status === 'init') {
                // セッションの初期化（GPU/メモリへの展開フェーズ）
                const label = file.includes('.onnx_data') ? '外部重みデータを展開中' : 'モデル初期化中';
                postMessage({ status: 'loading', output: `${label}: ${file || 'セッション作成中...'}` });
            }
        }
    };
    generatorPromise = pipeline(task, modelId, options);
    return generatorPromise;
}

// デバイスの判定（WebGPUが使えればWebGPU、ダメならCPUのWASMへ自動フォールバック）
async function checkDevice() {
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) return 'webgpu';
        } catch (e) { }
    }
    return 'wasm';
}

// -------------------------------------------------
// Pre‑download a lightweight model (or Vision model if GPU is available)
// This runs when the worker script is evaluated, so the UI
// does not have to wait for the first request.
// -------------------------------------------------
(async () => {
    try {
        const dev = await checkDevice();
        const preModelId = 'onnx-community/Qwen2.5-0.5B-Instruct';
        const task = 'text-generation';
        postMessage({ status: 'loading', output: `Pre‑download initializing (${dev.toUpperCase()})...` });
        
        await initGenerator(task, preModelId, dev);
        
        postMessage({ status: 'loading', output: 'Model pre‑download completed.' });
    } catch (e) {
        console.warn('Pre‑download failed:', e);
        // ignore – fallback will happen on first request
    }
})();

self.onmessage = async (e) => {
    const { type, prompt, image, modelId: requestedModelId, token } = e.data;

    if (type === 'generate') {
        try {
            let currentDevice = await checkDevice();
            
            // UIで選ばれたモデルをそのまま使用（未指定ならQwen 0.5B）
            const modelId = requestedModelId || 'onnx-community/Qwen2.5-0.5B-Instruct';
            const isVLM = modelId.includes('VL');
            const task = isVLM ? 'image-to-text' : 'text-generation';
            let useVision = !!image && isVLM;

            let warning = "";
            if (image && currentDevice === 'wasm') {
                warning = "⚠️ WebGPU未対応のため、CPU(WASM)で画像解析を実行します。非常に時間がかかります。";
            } else if (currentDevice === 'wasm') {
                warning = "⚠️ WebGPU未対応のため、CPU(WASM)で実行します。推論に時間がかかります。";
            }

            let generator;
            // Attempt to load the selected model, fallback to a tiny model on failure
            try {
                postMessage({ status: 'loading', output: `初期化中... (エンジン: ${currentDevice.toUpperCase()})` });
                generator = await initGenerator(task, modelId, currentDevice, token);
                if (!generator) throw new Error("Generator initialization failed.");
                generator.modelId = modelId;
            } catch (e) {
                // 再試行を可能にするため、失敗したプロミスのキャッシュをクリア
                generatorPromise = null; 
                currentGeneratorModelId = null; 
                lastToken = null;
                env.token = null; // 失敗時は環境変数をリセット

                const errorMsg = String(e); // e.message だけでなく Error 全体を文字列化して判定
                const isAuthError = /401|403|unauthorized|forbidden|credentials|login/i.test(errorMsg);
                
                // 技術的なセッション作成失敗（MountedFilesなど）
                const isSessionError = errorMsg.includes('session') || errorMsg.includes('Deserialize') || 
                                       errorMsg.includes('MountedFiles') || errorMsg.includes('NO_DEVICE_SPACE') || 
                                       errorMsg.includes('mounted') || errorMsg.includes('abort');

                const isGated = modelId.toLowerCase().includes('gemma') || modelId.toLowerCase().includes('llama');

                const isQuotaError = errorMsg.includes('quota') || 
                                       errorMsg.includes('QuotaExceededError') || 
                                       errorMsg.includes('NO_DEVICE_SPACE') ||
                                       errorMsg.includes('1588752864') ||
                                       errorMsg.includes('DataError') ||
                                       errorMsg.includes('DEVICE_SPACE') ||
                                       errorMsg.includes('0x80520010') ||
                                       errorMsg.includes('No device space');

                if (isQuotaError || isSessionError || errorMsg.includes('MountedFiles')) {
                    let detail = `[ストレージ異常/容量不足] ディスクが一杯か、ブラウザがモデルデータの書き込みを拒否しました。 (Error: ${errorMsg})`;
                    if (errorMsg.includes('MountedFiles')) {
                        detail = `[OPFSマウント失敗] ブラウザが仮想ファイルシステムの作成を拒否しました。容量は十分ですが、ブラウザの設定やセキュリティ制約（COOP/COEPヘッダーの欠如など）により、このサイトからのディスク書き込みがブロックされています。`;
                    } else if (isQuotaError) {
                        detail = `[ストレージ容量不足] ディスクが一杯です。不要なモデルを削除してください。`;
                    }
                    postMessage({ status: 'error', error: detail });
                    return;
                }

                // Gatedモデル（要同意）でないのに 403 が出る場合は、認証の問題ではなくネットワーク遮断の可能性が高い
                if (isAuthError && isGated) {
                    postMessage({ status: 'auth_error', modelId: modelId, error: errorMsg, isTechnical: false });
                    return;
                } else if (isAuthError && !isGated) {
                    // 公開モデルでの 403 は「アクセス制限（ネットワーク/プロキシ等）」として扱う
                    throw new Error(`[Network/Access Denied] ${errorMsg}`);
                } else {
                    // isSessionError (セッション作成失敗) の場合も、Gatedモデルだからと決めつけず
                    // 技術的なエラーとしてそのまま投げる。これにより、ダウンロード後の拒否が
                    // 認証不備なのか、デバイスのメモリ不足(OOM)なのかをユーザーが判断しやすくする。
                    console.error('Model load failed:', e);
                    throw e;
                }
            }
            postMessage({ status: 'loading', output: `推論中... (${currentDevice.toUpperCase()})` });

            let inputs;
            if (useVision) {
                // 画像がある場合のQwen2-VLのフォーマット
                const messages = [
                    {
                        role: "user",
                        content: [
                            { type: "image" },
                            { type: "text", text: prompt }
                        ]
                    }
                ];
                const rawImg = await RawImage.fromURL(image);
                let formattedPrompt;
                try {
                    formattedPrompt = generator.tokenizer.apply_chat_template(messages, {
                        tokenize: false,
                        add_generation_prompt: true
                    });
                } catch (e) {
                    // Fallback: simple concatenation when chat template not defined
                    formattedPrompt = prompt;
                }
                inputs = { texts: formattedPrompt, images: [rawImg] };
            } else {
                // テキストのみのフォーマット
                const messages = [
                    { role: "system", content: "You are a concise AI assistant. Answer only what is asked using the provided context." },
                    { role: "user", content: prompt }
                ];
                let formattedPrompt;
                try {
                    formattedPrompt = generator.tokenizer.apply_chat_template(messages, {
                        tokenize: false,
                        add_generation_prompt: true
                    });
                } catch (e) {
                    // Fallback: simple concatenation when chat template not defined
                    formattedPrompt = prompt;
                }
                inputs = formattedPrompt;
            }

            // --- トークン生成制限の調整 ---
            const isTinyFallback = generator.modelId === 'onnx-community/Qwen2.5-0.5B-Instruct';
            const isGpt2 = generator.modelId.includes('gpt2');
            let maxNewTokens = 1024;
            
            if (isTinyFallback) {
                // 入力が長すぎるとメモリ不足になるため、入力側のみ安全策をとる
                const promptText = typeof inputs === 'string' ? inputs : prompt;
                if (promptText.length > 2000) {
                    inputs = promptText.slice(0, 2000);
                    console.warn(`Input truncated to 2000 chars`);
                }
            } else if (isGpt2) {
                // GPT-2は出力も短めに制限して安定性を高める
                maxNewTokens = 256;
            } else {
                maxNewTokens = 1024;
            }

            let generatedText = "";
            let tokenCount = 0;
            const inferStartTime = Date.now();

            // ストリーマーの設定（逐次出力をUIに送る）
            const streamer = new TextStreamer(generator.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (text) => {
                    tokenCount++;
                    const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(1);
                    generatedText += text;
                    // 進捗付きでUIに送る
                    postMessage({ status: 'chunk', output: generatedText, tokenCount, elapsed, maxTokens: maxNewTokens, warning });
                }
            });

            // CPU(WASM)用: 推論開始前に進捗ヘッダーを表示
            if (isTinyFallback) {
                postMessage({ status: 'chunk', output: "", tokenCount: 0, elapsed: '0', maxTokens: maxNewTokens, warning });
            }

            // Run inference – タイムアウト付き
            // CPU (WASM) は非常に遅いため、タイムアウトを設けてフリーズを防ぐ
            const inferencePromise = (async () => {
                try {
                    // パラメータを整理。do_sample: false (Greedy Search) 時は temperature を無効化
                    const genConfig = { 
                        max_new_tokens: maxNewTokens, 
                        do_sample: false, 
                        streamer, 
                        repetition_penalty: isGpt2 ? undefined : 1.1 // GPT-2はペナルティに敏感なため除外
                    };
                    await generator(inputs, genConfig);
                } catch (e) {
                    console.error('Inference execution error:', e);
                    const errDetail = String(e).includes('1588752864') ? 'Quota Exceeded (Memory/Disk Full)' : (e.message || 'generation failed');
                    generatedText += '\n' + `[Error: ${errDetail}]`;
                }
            })();

            // CPU推論にはタイムアウトを設ける（WebGPUは高速なので不要）
            if (currentDevice === 'wasm') {
                // ハートビート: 5秒ごとにUI側に経過時間を通知（フリーズと誤解されないように）
                const heartbeat = setInterval(() => {
                    const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(0);
                    postMessage({ status: 'heartbeat', elapsed, tokenCount, maxTokens: maxNewTokens, warning });
                }, 5000);

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('CPU_TIMEOUT')), CPU_INFERENCE_TIMEOUT_MS)
                );
                try {
                    await Promise.race([inferencePromise, timeoutPromise]);
                } catch (e) {
                    if (e.message === 'CPU_TIMEOUT') {
                        const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(0);
                        console.warn('CPU inference timed out after', elapsed, 's');
                        if (!generatedText) {
                            generatedText = `⏱️ CPU推論が${elapsed}秒でタイムアウトしました。質問を短くするか、Gemini APIをお使いください。`;
                        } else {
                            generatedText += `\n\n⏱️ (${elapsed}秒経過、タイムアウトにより途中で打ち切られました)`;
                        }
                    } else {
                        throw e;
                    }
                } finally {
                    clearInterval(heartbeat);
                }
            } else {
                await inferencePromise;
            }
            // If model produced no text, send a fallback message
            if (!generatedText.trim()) {
                generatedText = '回答が生成できませんでした。';
            }

            postMessage({ status: 'complete', output: generatedText.trim() });

        } catch (error) {
            console.error(error);
            if (error.message && error.message.includes('looping content')) {
                // Add the required tag and return the original prompt as fallback
                const safeOutput = '[ignoring loop detection]\n' + prompt;
                postMessage({ status: 'complete', output: safeOutput.trim() });
            } else {
                postMessage({ status: 'error', error: error.toString() });
            }
        }

    }
};
