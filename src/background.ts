// Service worker. Holds the wallet state in memory + chrome.storage,
// routes RPC requests from content scripts, prompts the user via popup
// for sensitive operations.

import { Wallet, JsonRpcProvider, getBytes } from "ethers";
import { CHAINS, findChain } from "./chains";
import { encrypt, decrypt, type EncryptedBlob } from "./crypto";

type WalletRecord = {
  id: string;
  name: string;
  address: string;
  encrypted: EncryptedBlob;
};

type State = {
  wallets: WalletRecord[];
  selectedWalletId: string | null;
  selectedChainId: number;
  // origin -> { address, chainId } for sites the user has approved
  permissions: Record<string, { address: string }>;
};

const DEFAULT_STATE: State = {
  wallets: [],
  selectedWalletId: null,
  selectedChainId: 56,
  permissions: {}
};

// In-memory unlock cache — wallet plaintext secret. Cleared on service-worker eviction.
let unlockedSecret: string | null = null;
let unlockedWalletId: string | null = null;

async function getState(): Promise<State> {
  const r = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(r.state ?? {}) };
}
async function setState(patch: Partial<State>): Promise<void> {
  const cur = await getState();
  await chrome.storage.local.set({ state: { ...cur, ...patch } });
}

// ─── Pending request queue (popup polls these) ──────────────────────────────
type Pending = {
  id: string;
  origin: string;
  host: string;
  method: string;
  params: unknown[];
  resolve: (result: unknown) => void;
  reject: (err: { code: number; message: string }) => void;
  createdAt: number;
};
const pendingRequests = new Map<string, Pending>();

(globalThis as unknown as { _defiWalletPending: typeof pendingRequests })._defiWalletPending = pendingRequests;

// ─── Message routing ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "rpc-request") {
    handleRpc(msg.method, msg.params ?? [], msg.origin ?? "", msg.host ?? "")
      .then((result) => sendResponse({ result }))
      .catch((e: { code?: number; message: string }) => sendResponse({ error: { code: e.code ?? -32603, message: e.message } }));
    return true; // async
  }
  if (msg?.type === "popup:list-pending") {
    sendResponse([...pendingRequests.values()].map((p) => ({ id: p.id, origin: p.origin, host: p.host, method: p.method, params: p.params, createdAt: p.createdAt })));
    return false;
  }
  if (msg?.type === "popup:approve") {
    const p = pendingRequests.get(msg.id);
    if (!p) { sendResponse({ ok: false, error: "not found" }); return false; }
    finishRequest(p, msg).then((res) => sendResponse(res));
    return true;
  }
  if (msg?.type === "popup:reject") {
    const p = pendingRequests.get(msg.id);
    if (p) { p.reject({ code: 4001, message: "User rejected" }); pendingRequests.delete(p.id); }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "popup:unlock") {
    unlock(msg.password, msg.walletId).then((r) => sendResponse(r));
    return true;
  }
  if (msg?.type === "popup:lock") {
    unlockedSecret = null; unlockedWalletId = null;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "popup:state") {
    Promise.all([getState(), Promise.resolve(unlockedWalletId)]).then(([s, u]) => sendResponse({ state: s, unlockedWalletId: u, chains: CHAINS }));
    return true;
  }
  if (msg?.type === "popup:create-wallet") {
    createWallet(msg.name, msg.privateKey, msg.password).then((r) => sendResponse(r));
    return true;
  }
  if (msg?.type === "popup:select-wallet") {
    setState({ selectedWalletId: msg.id }).then(() => { broadcastEvent("accountsChanged", []); sendResponse({ ok: true }); });
    return true;
  }
  if (msg?.type === "popup:select-chain") {
    setState({ selectedChainId: msg.id }).then(() => {
      broadcastEvent("chainChanged", "0x" + msg.id.toString(16));
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

// ─── Core RPC handler ───────────────────────────────────────────────────────
async function handleRpc(method: string, params: unknown[], origin: string, host: string): Promise<unknown> {
  const state = await getState();
  const chain = findChain(state.selectedChainId);
  if (!chain) throw { code: -32602, message: "no active chain" };
  const wallet = state.wallets.find((w) => w.id === state.selectedWalletId);

  // Sites that haven't been granted access: only allow read methods + connect requests
  const granted = !!state.permissions[origin];

  switch (method) {
    case "eth_chainId": return "0x" + chain.id.toString(16);
    case "net_version": return String(chain.id);

    case "eth_accounts": {
      if (!granted || !wallet) return [];
      return [wallet.address];
    }

    case "eth_requestAccounts": {
      if (!wallet) {
        // Open popup to create/import a wallet first
        await openPopup();
        throw { code: 4100, message: "No wallet — create one in the extension popup, then retry." };
      }
      if (granted) return [wallet.address];
      // Prompt user
      await promptApproval({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }], origin, host });
      const fresh = await getState();
      fresh.permissions[origin] = { address: wallet.address };
      await chrome.storage.local.set({ state: fresh });
      return [wallet.address];
    }

    case "wallet_switchEthereumChain": {
      const target = (params[0] as { chainId: string }).chainId;
      const id = parseInt(target, 16);
      if (!findChain(id)) throw { code: 4902, message: `Unknown chain ${id}` };
      await setState({ selectedChainId: id });
      broadcastEvent("chainChanged", target);
      return null;
    }

    case "personal_sign":
    case "eth_sign":
    case "eth_signTypedData":
    case "eth_signTypedData_v4":
    case "eth_sendTransaction": {
      if (!wallet) throw { code: 4100, message: "No wallet" };
      if (!granted) throw { code: 4100, message: "Connect this site first via eth_requestAccounts" };
      const result = await promptApproval({ method, params, origin, host });
      return result;
    }

    default: {
      // Pass-through to RPC for read-only methods
      try {
        const provider = new JsonRpcProvider(chain.rpcUrl, chain.id);
        return await provider.send(method, params);
      } catch (e: unknown) {
        throw { code: -32603, message: (e as Error).message };
      }
    }
  }
}

// ─── Approval flow ──────────────────────────────────────────────────────────
async function promptApproval(req: { method: string; params: unknown[]; origin: string; host: string }): Promise<unknown> {
  const id = crypto.randomUUID();
  const promise = new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(id, { id, ...req, resolve, reject, createdAt: Date.now() });
  });
  // Update badge so the user notices
  chrome.action.setBadgeText({ text: String(pendingRequests.size) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#5b8cff" }).catch(() => {});
  await openPopup();
  return promise;
}

async function finishRequest(p: Pending, msg: { id: string; password?: string }): Promise<{ ok: boolean; error?: string }> {
  const state = await getState();
  const wallet = state.wallets.find((w) => w.id === state.selectedWalletId);
  if (!wallet) { p.reject({ code: 4100, message: "no wallet" }); pendingRequests.delete(p.id); return { ok: false, error: "no wallet" }; }

  // Permission grants don't need a signing key — just record the grant
  if (p.method === "wallet_requestPermissions") {
    p.resolve(null);
    pendingRequests.delete(p.id);
    refreshBadge();
    return { ok: true };
  }

  // Need the unlocked secret for any signing
  if (!unlockedSecret || unlockedWalletId !== wallet.id) {
    if (!msg.password) return { ok: false, error: "password required" };
    try {
      unlockedSecret = await decrypt(wallet.encrypted, msg.password);
      unlockedWalletId = wallet.id;
    } catch { return { ok: false, error: "wrong password" }; }
  }

  try {
    const chain = findChain(state.selectedChainId);
    if (!chain) throw new Error("no chain");
    const signer = new Wallet(unlockedSecret).connect(new JsonRpcProvider(chain.rpcUrl, chain.id));
    let result: unknown;

    switch (p.method) {
      case "eth_sendTransaction": {
        const tx = p.params[0] as { to: string; value?: string; data?: string; gas?: string };
        const sent = await signer.sendTransaction({
          to: tx.to,
          value: tx.value ? BigInt(tx.value) : 0n,
          data: tx.data,
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined
        });
        result = sent.hash;
        break;
      }
      case "personal_sign": {
        const m = p.params[0] as string;
        const bytes = m.startsWith("0x") ? getBytes(m) : m;
        result = await signer.signMessage(bytes);
        break;
      }
      case "eth_sign":
        result = await signer.signMessage(p.params[1] as string);
        break;
      case "eth_signTypedData":
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(p.params[1] as string);
        result = await signer.signTypedData(typed.domain, typed.types, typed.message);
        break;
      }
      default:
        throw new Error(`unsupported: ${p.method}`);
    }

    p.resolve(result);
    pendingRequests.delete(p.id);
    refreshBadge();
    return { ok: true };
  } catch (e) {
    p.reject({ code: -32000, message: (e as Error).message });
    pendingRequests.delete(p.id);
    refreshBadge();
    return { ok: false, error: (e as Error).message };
  }
}

function refreshBadge() {
  chrome.action.setBadgeText({ text: pendingRequests.size > 0 ? String(pendingRequests.size) : "" }).catch(() => {});
}

// ─── Wallet management ──────────────────────────────────────────────────────
async function createWallet(name: string, privateKey: string | null, password: string): Promise<{ ok: boolean; error?: string; walletId?: string }> {
  try {
    const w = privateKey ? new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) : Wallet.createRandom();
    const encrypted = await encrypt(w.privateKey, password);
    const record: WalletRecord = { id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, name, address: w.address, encrypted };
    const state = await getState();
    state.wallets.push(record);
    state.selectedWalletId = record.id;
    await chrome.storage.local.set({ state });
    return { ok: true, walletId: record.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function unlock(password: string, walletId: string): Promise<{ ok: boolean; error?: string; address?: string }> {
  const state = await getState();
  const w = state.wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, error: "wallet not found" };
  try {
    unlockedSecret = await decrypt(w.encrypted, password);
    unlockedWalletId = w.id;
    return { ok: true, address: w.address };
  } catch {
    return { ok: false, error: "wrong password" };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function broadcastEvent(event: string, ...args: unknown[]): void {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "event", event, args }).catch(() => {});
    }
  });
}

async function openPopup(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    // openPopup() can fail if not triggered by user gesture — just ensure the
    // badge is set so the user knows there's something pending.
  }
}
