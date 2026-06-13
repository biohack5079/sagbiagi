self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

    event.respondWith(
        fetch(request).then((response) => {
            // 状態が 0 (不透明) またはエラーレスポンスの場合は加工せずにそのまま返す
            if (response.status === 0 || (!response.ok && response.status !== 206)) {
                return response;
            }

            // 共有メモリ (SharedArrayBuffer) を利用するために必要なセキュリティヘッダーを注入
            const newHeaders = new Headers(response.headers);
            newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
            newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });
        }).catch(() => fetch(request)) // 失敗時のセーフティネット
    );
});