self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
    const { request } = event;
    
    // ViteのHMR(hot-reload)や、特定のキャッシュリクエストは中継しない
    if (request.url.includes('hmr') || (request.cache === "only-if-cached" && request.mode !== "same-origin")) return;

    event.respondWith(
        fetch(request).then((response) => {
            // 不透明なレスポンスやエラー（404等）はそのまま返す
            if (response.status === 0 || !response.ok) {
                return response;
            }

            // SharedArrayBuffer (WebGPU/WASM) に必要なヘッダーを付与
            const newHeaders = new Headers(response.headers);
            newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
            newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });
        }).catch((err) => {
            // ネットワークエラー時はリトライせず、エラーをそのままブラウザに報告させる
            throw err;
        })
    );
});