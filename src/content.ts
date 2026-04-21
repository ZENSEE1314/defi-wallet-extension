// Runs in every page at document_start in an isolated world.
// Injects inpage.js into the real page context and bridges messages.

(() => {
  // 1. Inject the EIP-1193 provider script into the page
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inpage.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).prepend(script);

  // 2. Page → background bridge
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.target !== "defi-wallet-content" || msg.type !== "rpc-request") return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "rpc-request",
        method: msg.method,
        params: msg.params,
        origin: location.origin,
        host: location.hostname
      });
      window.postMessage(
        { target: "defi-wallet-inpage", type: "rpc-response", id: msg.id, result: response?.result, error: response?.error },
        "*"
      );
    } catch (e) {
      window.postMessage(
        { target: "defi-wallet-inpage", type: "rpc-response", id: msg.id, error: { code: -32603, message: (e as Error).message } },
        "*"
      );
    }
  });

  // 3. Background → page bridge (events like accountsChanged / chainChanged)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "event") {
      window.postMessage({ target: "defi-wallet-inpage", type: "event", event: msg.event, args: msg.args }, "*");
    }
  });
})();
