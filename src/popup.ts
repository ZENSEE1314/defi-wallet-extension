// Popup UI — vanilla TS, no React (keeps the bundle tiny).

import { CHAINS, type Chain } from "./chains";

type WalletRecord = { id: string; name: string; address: string; encrypted: unknown };
type State = {
  wallets: WalletRecord[];
  selectedWalletId: string | null;
  selectedChainId: number;
  permissions: Record<string, { address: string }>;
};
type Pending = { id: string; origin: string; host: string; method: string; params: unknown[] };

let state: State;
let unlockedWalletId: string | null = null;

const $root = document.getElementById("root")!;

async function send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const r = await send<{ state: State; unlockedWalletId: string | null }>({ type: "popup:state" });
  state = r.state;
  unlockedWalletId = r.unlockedWalletId;
  const pending = await send<Pending[]>({ type: "popup:list-pending" });
  render(pending);
}

function render(pending: Pending[]) {
  const isLocked = !unlockedWalletId;
  $root.innerHTML = "";

  // Header
  const header = el(`
    <h1><span class="logo">D</span> DeFi Wallet</h1>
  `);
  $root.appendChild(header);

  // Onboarding: no wallets yet
  if (state.wallets.length === 0) {
    $root.appendChild(renderCreateForm());
    return;
  }

  // Pending requests jump to the top
  if (pending.length > 0) {
    $root.appendChild(renderPending(pending[0], isLocked));
    return;
  }

  // Locked? Show unlock
  if (isLocked) {
    $root.appendChild(renderUnlock());
    return;
  }

  // Normal view
  $root.appendChild(renderActive());
}

function renderCreateForm(): HTMLElement {
  const card = el(`
    <div class="card">
      <h2 style="margin-top:0">Set up wallet</h2>
      <div class="tabs">
        <button data-mode="new" class="active">+ New</button>
        <button data-mode="import">Import key</button>
      </div>
      <div id="form"></div>
    </div>
  `);
  let mode: "new" | "import" = "new";
  const renderForm = () => {
    const f = card.querySelector("#form")!;
    f.innerHTML = "";
    // IMPORTANT: wrap each label+input in a div so the el() helper (which only
    // returns firstElementChild) keeps both rendered.
    f.appendChild(el(`<div><label>Wallet name</label><input id="name" value="Main wallet" /></div>`));
    if (mode === "import") {
      f.appendChild(el(`<div><label>Private key (0x…)</label><input id="key" placeholder="0x…" /></div>`));
    }
    f.appendChild(el(`<div><label>Password (8+ chars)</label><input id="pwd" type="password" /></div>`));
    f.appendChild(el(`<button class="full" id="go" style="margin-top:10px">${mode === "new" ? "Create" : "Import"}</button>`));
    f.appendChild(el(`<div id="err" class="error" style="display:none"></div>`));
    f.querySelector("#go")!.addEventListener("click", async () => {
      const name = (f.querySelector("#name") as HTMLInputElement).value;
      const pwd = (f.querySelector("#pwd") as HTMLInputElement).value;
      const key = mode === "import" ? (f.querySelector("#key") as HTMLInputElement).value : null;
      const err = f.querySelector("#err")! as HTMLElement;
      err.style.display = "none";
      if (!name || pwd.length < 8) { err.textContent = "Name + 8+ char password required"; err.style.display = "block"; return; }
      const r = await send<{ ok: boolean; error?: string }>({ type: "popup:create-wallet", name, password: pwd, privateKey: key });
      if (!r.ok) { err.textContent = r.error ?? "failed"; err.style.display = "block"; return; }
      // Auto-unlock
      const u = await send<{ ok: boolean }>({ type: "popup:unlock", password: pwd, walletId: (await send<{ state: State }>({ type: "popup:state" })).state.selectedWalletId });
      if (u.ok) refresh();
    });
  };
  card.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      mode = (b as HTMLElement).dataset.mode as "new" | "import";
      card.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.mode === mode));
      renderForm();
    });
  });
  renderForm();
  return card;
}

function renderUnlock(): HTMLElement {
  const w = state.wallets.find((x) => x.id === state.selectedWalletId) ?? state.wallets[0];
  const card = el(`
    <div class="card">
      <h2 style="margin-top:0">Unlock</h2>
      <div class="muted">${escapeHtml(w.name)}</div>
      <div class="address mono">${w.address}</div>
      <div><label>Password</label><input id="pwd" type="password" autofocus /></div>
      <div id="err" class="error" style="display:none"></div>
      <button class="full" id="go" style="margin-top:10px">Unlock</button>
    </div>
  `);
  card.querySelector("#go")!.addEventListener("click", async () => {
    const pwd = (card.querySelector("#pwd") as HTMLInputElement).value;
    const err = card.querySelector("#err")! as HTMLElement;
    const r = await send<{ ok: boolean; error?: string }>({ type: "popup:unlock", password: pwd, walletId: w.id });
    if (!r.ok) { err.textContent = r.error ?? "failed"; err.style.display = "block"; return; }
    refresh();
  });
  card.querySelector("#pwd")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") (card.querySelector("#go") as HTMLButtonElement).click();
  });
  return card;
}

function renderActive(): HTMLElement {
  const wrap = document.createElement("div");
  const w = state.wallets.find((x) => x.id === state.selectedWalletId)!;
  const chain = CHAINS.find((c) => c.id === state.selectedChainId) ?? CHAINS[0];

  // Wallet card
  wrap.appendChild(el(`
    <div class="card">
      <div class="row">
        <div>
          <div style="font-weight:600">${escapeHtml(w.name)}</div>
          <div class="address mono">${w.address}</div>
        </div>
        <button class="secondary" id="copy">Copy</button>
      </div>
    </div>
  `));
  wrap.querySelector("#copy")!.addEventListener("click", () => navigator.clipboard.writeText(w.address));

  // Network selector
  const netCard = el(`
    <div class="card">
      <label style="margin-top:0">Network</label>
      <select id="chain"></select>
    </div>
  `);
  const sel = netCard.querySelector("#chain") as HTMLSelectElement;
  CHAINS.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.id); opt.textContent = c.name;
    if (c.id === chain.id) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => send({ type: "popup:select-chain", id: Number(sel.value) }).then(refresh));
  wrap.appendChild(netCard);

  // Wallet switcher (if multiple)
  if (state.wallets.length > 1) {
    const wCard = el(`<div class="card"><label style="margin-top:0">Active wallet</label><select id="ws"></select></div>`);
    const ws = wCard.querySelector("#ws") as HTMLSelectElement;
    state.wallets.forEach((x) => {
      const opt = document.createElement("option");
      opt.value = x.id; opt.textContent = `${x.name} — ${x.address.slice(0, 8)}…`;
      if (x.id === w.id) opt.selected = true;
      ws.appendChild(opt);
    });
    ws.addEventListener("change", () => send({ type: "popup:select-wallet", id: ws.value }).then(refresh));
    wrap.appendChild(wCard);
  }

  // Connected sites
  const conns = Object.entries(state.permissions);
  if (conns.length > 0) {
    const card = el(`<div class="card"><h2 style="margin:0 0 8px">Connected sites</h2></div>`);
    for (const [origin] of conns) {
      const row = el(`<div class="row" style="margin-top:6px"><span class="muted">${escapeHtml(origin)}</span><button class="secondary" data-org="${escapeHtml(origin)}">×</button></div>`);
      row.querySelector("button")!.addEventListener("click", async () => {
        const s = state;
        delete s.permissions[origin];
        await chrome.storage.local.set({ state: s });
        refresh();
      });
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }

  // Footer actions
  const foot = el(`
    <div class="btn-row">
      <button class="secondary" id="add">+ Add wallet</button>
      <button class="danger" id="lock">Lock</button>
    </div>
  `);
  foot.querySelector("#lock")!.addEventListener("click", () => send({ type: "popup:lock" }).then(refresh));
  foot.querySelector("#add")!.addEventListener("click", () => {
    $root.innerHTML = "";
    $root.appendChild(el(`<h1><span class="logo">D</span> Add wallet</h1>`));
    $root.appendChild(renderCreateForm());
  });
  wrap.appendChild(foot);

  return wrap;
}

function renderPending(p: Pending, isLocked: boolean): HTMLElement {
  const w = state.wallets.find((x) => x.id === state.selectedWalletId);
  const summary = summariseRequest(p);
  const card = el(`
    <div class="card pending">
      <h2 style="margin-top:0;color:#ffb454">⚠ Approval required</h2>
      <div class="row"><span class="muted">From</span><span class="mono">${escapeHtml(p.host)}</span></div>
      <div class="row"><span class="muted">Method</span><span class="mono">${escapeHtml(p.method)}</span></div>
      <div class="row"><span class="muted">Wallet</span><span class="address mono">${w?.address?.slice(0, 18)}…</span></div>
      <pre>${escapeHtml(summary)}</pre>
      ${isLocked ? `<div><label>Password</label><input id="pwd" type="password" autofocus /></div>` : ""}
      <div id="err" class="error" style="display:none"></div>
      <div class="btn-row">
        <button class="secondary" id="rej">Reject</button>
        <button id="apr">Approve</button>
      </div>
    </div>
  `);
  card.querySelector("#rej")!.addEventListener("click", async () => {
    await send({ type: "popup:reject", id: p.id });
    refresh();
  });
  card.querySelector("#apr")!.addEventListener("click", async () => {
    const err = card.querySelector("#err")! as HTMLElement;
    const pwd = isLocked ? (card.querySelector("#pwd") as HTMLInputElement).value : undefined;
    if (isLocked && (!pwd || pwd.length < 1)) { err.textContent = "Password required"; err.style.display = "block"; return; }
    const r = await send<{ ok: boolean; error?: string }>({ type: "popup:approve", id: p.id, password: pwd });
    if (!r.ok) { err.textContent = r.error ?? "failed"; err.style.display = "block"; return; }
    refresh();
  });
  return card;
}

function summariseRequest(p: Pending): string {
  switch (p.method) {
    case "wallet_requestPermissions": return "Allow this site to read your address and request signatures.";
    case "personal_sign": {
      const m = String(p.params[0] ?? "");
      const text = m.startsWith("0x") ? hexToText(m) : m;
      return `Message to sign:\n\n${text.slice(0, 600)}`;
    }
    case "eth_sendTransaction": {
      const t = p.params[0] as { to?: string; value?: string; data?: string };
      const valEth = t.value ? (Number(BigInt(t.value)) / 1e18).toFixed(6) : "0";
      return `to:    ${t.to ?? "(create)"}\nvalue: ${valEth} (native)\ndata:  ${(t.data ?? "0x").slice(0, 80)}…`;
    }
    case "eth_signTypedData":
    case "eth_signTypedData_v4":
      return JSON.stringify(JSON.parse(String(p.params[1])), null, 2).slice(0, 600);
    default:
      return JSON.stringify(p.params, null, 2).slice(0, 600);
  }
}

function hexToText(hex: string): string {
  try {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    let s = "";
    for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    // If it looks like text, return as text; else show hex
    return /^[\x20-\x7e\n\r\t]+$/.test(s) ? s : hex;
  } catch { return hex; }
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

refresh();
// Re-poll for new pending requests every 2s while popup is open
setInterval(refresh, 2000);
