// Injected into every dApp's page context. Implements EIP-1193 + EIP-6963.
// Communicates with the content script via window.postMessage.

type Listener = (...args: unknown[]) => void;

class InjectedProvider {
  // dApps sniff these flags to pick a wallet
  isMetaMask = true; // many older dApps gate on this — say yes for compatibility
  isDeFiWallet = true;
  private listeners = new Map<string, Set<Listener>>();
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private connected = false;
  private currentChainId = "0x38"; // BSC default

  constructor() {
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.target !== "defi-wallet-inpage") return;

      if (msg.type === "rpc-response") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.type === "event") {
        this.emit(msg.event, ...(msg.args ?? []));
        if (msg.event === "chainChanged" && typeof msg.args?.[0] === "string") {
          this.currentChainId = msg.args[0];
        }
      }
    });
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage({ target: "defi-wallet-content", type: "rpc-request", id, method: args.method, params: args.params ?? [] }, "*");
    }).then((result) => {
      if ((args.method === "eth_requestAccounts" || args.method === "eth_accounts") && !this.connected) {
        this.connected = true;
        this.emit("connect", { chainId: this.currentChainId });
      }
      return result;
    });
  }

  // legacy compatibility
  async send(methodOrPayload: string | { method: string; params?: unknown[] }, paramsOrCallback?: unknown[] | ((err: Error | null, res?: unknown) => void)): Promise<unknown> {
    if (typeof methodOrPayload === "string") {
      return this.request({ method: methodOrPayload, params: paramsOrCallback as unknown[] });
    }
    return this.request(methodOrPayload);
  }

  sendAsync(payload: { method: string; params?: unknown[]; id?: number }, callback: (err: Error | null, res?: { id?: number; jsonrpc: "2.0"; result?: unknown; error?: { message: string } }) => void): void {
    this.request(payload).then(
      (result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }),
      (err) => callback(null, { id: payload.id, jsonrpc: "2.0", error: { message: err.message } })
    );
  }

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }
  removeListener(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => {
      try { fn(...args); } catch (e) { console.error("[DeFi Wallet] listener error", e); }
    });
  }
}

const provider = new InjectedProvider();

// Set as window.ethereum (the de-facto standard most dApps use)
const w = window as unknown as { ethereum?: unknown };
if (!w.ethereum) {
  Object.defineProperty(w, "ethereum", { value: provider, writable: false, configurable: false });
} else {
  // If MetaMask or another wallet is already there, don't override — register via EIP-6963 instead
  console.log("[DeFi Wallet] another window.ethereum exists, registering via EIP-6963 only");
}

// EIP-6963 multi-wallet announcement
const info = {
  uuid: crypto.randomUUID(),
  name: "DeFi Wallet",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0iIzViOGNmZiI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiLz48dGV4dCB4PSIzMiIgeT0iNDQiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjM2IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkQ8L3RleHQ+PC9zdmc+",
  rdns: "com.zensee.defi-wallet"
};
const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
window.addEventListener("eip6963:requestProvider", announce);
announce();
