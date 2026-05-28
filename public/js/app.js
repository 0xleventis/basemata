/**
 * Base Token Registry — Frontend JS
 * Replace WORKER_URL and GITHUB_CLIENT_ID with your actual values before deploying.
 */

const CONFIG = {
  // Railway serves both frontend and API from the same domain.
  // No URL change needed — just set GITHUB_CLIENT_ID below.
  WORKER_URL: window.location.origin,
  GITHUB_CLIENT_ID: "Iv23liwEe0bfZHY82lS4",  // ← paste your GitHub OAuth App client ID here
  REDIRECT_URI: window.location.origin + "/auth/callback",
};

const DEXES = [
  { id: "uniswap",   name: "Uniswap",        sub: "tokenlists.org",              repo: "Uniswap/default-token-list" },
  { id: "aerodrome", name: "Aerodrome",       sub: "aerodrome-finance",           repo: "aerodrome-finance/tokenlist" },
  { id: "baseswap",  name: "BaseSwap",        sub: "BaseSwapDex",                 repo: "BaseSwapDex/token-list" },
  { id: "coinbase",  name: "Coinbase Wallet", sub: "coinbase token list",         repo: "coinbase/node-wallets-ecosystem-token-list" },
  { id: "sushi",     name: "SushiSwap",       sub: "sushiswap default list",      repo: "sushiswap/default-token-list" },
  { id: "trust",     name: "Trust Wallet",    sub: "assets.trustwallet.com",      repo: "trustwallet/assets" },
];

// ── State ──────────────────────────────────────────────────────────────────────
let state = {
  step: 0,
  ghUser: null,
  ghToken: null,
  logoFile: null,
  logoDataURL: null,
  logoBase64: null,
  logoMimeType: null,
  tags: [],
  selectedRegs: new Set(["uniswap", "aerodrome", "baseswap", "coinbase"]),
  contractValid: null,
  validateTimer: null,
  prStatuses: {},
  submitting: false,
};

// ── Step navigation ─────────────────────────────────────────────────────────────
function goStep(n) {
  state.step = n;
  document.querySelectorAll(".step").forEach((el, i) => {
    el.classList.toggle("active", i === n);
    el.setAttribute("aria-selected", i === n);
  });
  document.querySelectorAll(".step-panel").forEach((el, i) => {
    el.classList.toggle("active", i === n);
  });
  if (n === 3) buildReview();
  window.scrollTo({ top: document.querySelector(".form-section").offsetTop - 80, behavior: "smooth" });
}

// ── GitHub OAuth ────────────────────────────────────────────────────────────────
function connectGitHub() {
  const oauthState = crypto.randomUUID();
  sessionStorage.setItem("gh_oauth_state", oauthState);

  const params = new URLSearchParams({
    client_id: CONFIG.GITHUB_CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: "public_repo",
    state: oauthState,
  });

  const popup = window.open(
    `https://github.com/login/oauth/authorize?${params}`,
    "github-oauth",
    "width=620,height=720,left=200,top=60"
  );

  // Listen for OAuth callback message from popup
  const handler = async (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data?.gh_code) return;
    window.removeEventListener("message", handler);
    popup?.close();

    if (event.data.state !== oauthState) {
      showError("OAuth state mismatch — please try again");
      return;
    }

    document.getElementById("ghConnectBtn").textContent = "Connecting…";

    try {
      const res = await fetch(`${CONFIG.WORKER_URL}/auth/token?code=${event.data.gh_code}&state=${event.data.state}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      state.ghToken = data.access_token;
      state.ghUser = data.user;
      applyGHUser();
    } catch (e) {
      showError("GitHub auth failed: " + e.message);
      document.getElementById("ghConnectBtn").textContent = "Sign in with GitHub";
    }
  };

  window.addEventListener("message", handler);
}

// /auth/callback page — posts code back to opener then closes
function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (code && window.opener) {
    window.opener.postMessage({ gh_code: code, state }, window.location.origin);
    window.close();
  }
}

function applyGHUser() {
  document.getElementById("ghDisconnected").style.display = "none";
  document.getElementById("ghConnected").style.display = "block";

  const avatarEl = document.getElementById("ghAvatarEl");
  if (state.ghUser.avatar_url) {
    avatarEl.innerHTML = `<img src="${state.ghUser.avatar_url}" alt="${state.ghUser.login}" />`;
  } else {
    avatarEl.textContent = state.ghUser.login.slice(0, 2).toUpperCase();
  }

  document.getElementById("ghNameEl").textContent = state.ghUser.name || state.ghUser.login;
  document.getElementById("ghLoginEl").textContent = "@" + state.ghUser.login;
  document.getElementById("ghLoginBadge").textContent = "@" + state.ghUser.login;
}

function disconnectGitHub() {
  state.ghUser = null;
  state.ghToken = null;
  document.getElementById("ghConnected").style.display = "none";
  document.getElementById("ghDisconnected").style.display = "block";
}

// ── Logo upload ─────────────────────────────────────────────────────────────────
function initUpload() {
  const zone = document.getElementById("uploadZone");
  const input = document.getElementById("logoInput");

  input.addEventListener("change", (e) => handleLogoFile(e.target.files[0]));

  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("drag");
    handleLogoFile(e.dataTransfer.files[0]);
  });

  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") input.click();
  });
}

function handleLogoFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  state.logoFile = file;
  state.logoMimeType = file.type;

  const msgEl = document.getElementById("logoValidMsg");
  msgEl.style.display = "flex";
  msgEl.className = "field-msg";
  msgEl.textContent = "Checking image…";

  const reader = new FileReader();
  reader.onload = (ev) => {
    state.logoDataURL = ev.target.result;
    // Strip data URL prefix for base64
    state.logoBase64 = ev.target.result.split(",")[1];

    const img = new Image();
    img.onload = () => {
      const sizeKB = Math.round(file.size / 1024);
      const okSize = file.size < 102400;
      const okDims = img.width >= 256 && img.height >= 256;
      const okSquare = Math.abs(img.width - img.height) <= 2;

      const preview = document.getElementById("logoPreviewImg");
      const placeholder = document.getElementById("logoPlaceholder");
      preview.src = state.logoDataURL;
      preview.style.display = "block";
      placeholder.style.display = "none";

      if (okSize && okDims && okSquare) {
        msgEl.className = "field-msg ok";
        msgEl.innerHTML = `✓ ${img.width}×${img.height}px · ${sizeKB}KB — looks good`;
      } else {
        const issues = [];
        if (!okDims) issues.push(`min 256px required (got ${img.width}×${img.height})`);
        if (!okSquare) issues.push("must be square (1:1 aspect ratio)");
        if (!okSize) issues.push(`max 100KB (got ${sizeKB}KB)`);
        msgEl.className = "field-msg warn";
        msgEl.innerHTML = `⚠ ${issues.join(" · ")}`;
      }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ── Contract validation ─────────────────────────────────────────────────────────
function scheduleValidate() {
  clearTimeout(state.validateTimer);
  const addr = document.getElementById("tokenAddress").value.trim();
  const msgEl = document.getElementById("contractMsg");
  msgEl.style.display = "none";
  state.contractValid = null;

  if (!addr) return;

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    msgEl.style.display = "flex";
    msgEl.className = "field-msg err";
    msgEl.textContent = "Invalid address format";
    state.contractValid = false;
    return;
  }

  msgEl.style.display = "flex";
  msgEl.className = "field-msg";
  msgEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:7px"><span class="spin-sm"></span> Validating on Base…</span>';

  state.validateTimer = setTimeout(() => validateContract(addr), 800);
}

async function validateContract(addr) {
  const msgEl = document.getElementById("contractMsg");
  const chainId = document.getElementById("tokenChain").value;
  const rpc = chainId === "84532" ? "https://sepolia.base.org" : "https://mainnet.base.org";

  const call = async (data) => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addr, data }, "latest"] }),
    });
    return (await res.json()).result;
  };

  try {
    const nameHex = await call("0x06fdde03");
    if (!nameHex || nameHex === "0x") {
      msgEl.className = "field-msg warn";
      msgEl.textContent = "⚠ No ERC-20 contract found at this address on Base — check the selected network";
      state.contractValid = false;
      return;
    }

    const decodeName = (hex) => {
      const h = hex.slice(2);
      const offset = parseInt(h.slice(0, 64), 16) * 2;
      const len = parseInt(h.slice(offset, offset + 64), 16) * 2;
      return h.slice(offset + 64, offset + 64 + len)
        .match(/.{2}/g)
        .map((b) => String.fromCharCode(parseInt(b, 16)))
        .join("")
        .replace(/\0/g, "");
    };

    const name = decodeName(nameHex);
    const symHex = await call("0x95d89b41");
    const symbol = decodeName(symHex);
    const decHex = await call("0x313ce567");
    const decimals = decHex ? parseInt(decHex, 16) : 18;

    state.contractValid = true;
    msgEl.className = "field-msg ok";
    msgEl.innerHTML = `✓ Valid ERC-20 · <strong>${name}</strong> (${symbol}) · auto-filled below`;

    // Auto-fill
    const nameEl = document.getElementById("tokenName");
    const symEl = document.getElementById("tokenSymbol");
    const decEl = document.getElementById("tokenDecimals");
    if (!nameEl.value) nameEl.value = name;
    if (!symEl.value) symEl.value = symbol;
    if (!isNaN(decimals)) decEl.value = decimals;
  } catch (e) {
    msgEl.className = "field-msg warn";
    msgEl.textContent = "⚠ Could not reach Base RPC — fill in name/symbol manually";
  }
}

// ── Tags ────────────────────────────────────────────────────────────────────────
function initTags() {
  const input = document.getElementById("tagIn");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = input.value.trim().toLowerCase().replace(/,/g, "");
      if (val && !state.tags.includes(val) && state.tags.length < 12) {
        state.tags.push(val);
        renderTags();
        input.value = "";
      }
    } else if (e.key === "Backspace" && !input.value && state.tags.length) {
      state.tags.pop();
      renderTags();
    }
  });
}

function renderTags() {
  const field = document.getElementById("tagsField");
  const input = document.getElementById("tagIn");
  field.querySelectorAll(".tag-chip").forEach((t) => t.remove());
  state.tags.forEach((tag, i) => {
    const el = document.createElement("div");
    el.className = "tag-chip";
    el.innerHTML = `${tag}<button type="button" aria-label="Remove ${tag}" onclick="removeTag(${i})">×</button>`;
    field.insertBefore(el, input);
  });
}

function removeTag(i) {
  state.tags.splice(i, 1);
  renderTags();
}

// ── Registry grid ───────────────────────────────────────────────────────────────
function renderRegGrid() {
  document.getElementById("regGrid").innerHTML = DEXES.map((d) => `
    <div class="reg-item ${state.selectedRegs.has(d.id) ? "on" : ""}"
         onclick="toggleReg('${d.id}')"
         role="checkbox" aria-checked="${state.selectedRegs.has(d.id)}" tabindex="0"
         onkeydown="if(event.key==='Enter'||event.key===' ')toggleReg('${d.id}')">
      <div class="reg-check">
        ${state.selectedRegs.has(d.id) ? '<svg width="10" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="1 5 4.5 8.5 11 1"/></svg>' : ""}
      </div>
      <div class="reg-body">
        <div class="reg-name">${d.name}</div>
        <div class="reg-sub">${d.sub}</div>
        <div class="reg-repo">${d.repo}</div>
      </div>
    </div>`).join("");
}

function toggleReg(id) {
  if (state.selectedRegs.has(id)) state.selectedRegs.delete(id);
  else state.selectedRegs.add(id);
  renderRegGrid();
}

// ── Review ──────────────────────────────────────────────────────────────────────
function buildReview() {
  const d = getForm();
  const targets = DEXES.filter((x) => state.selectedRegs.has(x.id));

  const warnings = [];
  if (!d.address.match(/^0x[0-9a-fA-F]{40}$/)) warnings.push("Contract address is missing or invalid");
  if (!d.name) warnings.push("Token name is required");
  if (!d.symbol) warnings.push("Symbol is required");
  if (!state.logoFile) warnings.push("No logo uploaded");
  if (!state.ghUser) warnings.push("Not connected to GitHub — PRs cannot be opened");
  if (targets.length === 0) warnings.push("No registries selected");

  const warnHtml = warnings.length
    ? warnings.map((w) => `<div class="field-msg err" style="margin-bottom:8px">⚠ ${w}</div>`).join("")
    : "";

  document.getElementById("reviewContent").innerHTML = `
    ${warnHtml}
    <div class="review-grid">
      <div class="review-field">
        <label>Token name</label>
        <div class="val">${d.name || "<span style='color:#aaa'>—</span>"}</div>
      </div>
      <div class="review-field">
        <label>Symbol</label>
        <div class="val mono">${d.symbol || "<span style='color:#aaa'>—</span>"}</div>
      </div>
      <div class="review-field" style="grid-column:1/-1">
        <label>Contract address</label>
        <div class="val mono">${d.address || "<span style='color:#aaa'>—</span>"}</div>
      </div>
      <div class="review-field">
        <label>Chain ID</label>
        <div class="val">${d.chainId}</div>
      </div>
      <div class="review-field">
        <label>Decimals</label>
        <div class="val">${d.decimals}</div>
      </div>
      <div class="review-field">
        <label>Logo</label>
        <div class="val">${state.logoDataURL
          ? `<img src="${state.logoDataURL}" style="width:32px;height:32px;border-radius:50%;border:1px solid #e0deda;vertical-align:middle" alt="logo" /> uploaded`
          : "<span style='color:#e24b4b'>Missing</span>"
        }</div>
      </div>
      <div class="review-field">
        <label>GitHub</label>
        <div class="val">${state.ghUser ? "@" + state.ghUser.login : "<span style='color:#e24b4b'>Not connected</span>"}</div>
      </div>
    </div>
    <div style="font-size:12px;color:#999;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em">
      Submitting to ${targets.length} registr${targets.length === 1 ? "y" : "ies"}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${targets.map((t) => `<span style="font-size:12px;padding:4px 12px;border-radius:20px;background:#f0ede8;color:#555;font-weight:500">${t.name}</span>`).join("")}
    </div>`;

  document.getElementById("submitBtn").disabled = warnings.length > 0;
}

// ── Submit ──────────────────────────────────────────────────────────────────────
async function doSubmit() {
  if (state.submitting) return;
  const d = getForm();
  const targets = DEXES.filter((x) => state.selectedRegs.has(x.id));

  state.submitting = true;
  document.getElementById("submitBtn").disabled = true;
  document.getElementById("progWrap").style.display = "block";
  document.getElementById("prStatusCard").style.display = "block";

  state.prStatuses = {};
  targets.forEach((t) => (state.prStatuses[t.id] = "idle"));
  renderPRStatus(targets);

  setSubmitStatus("Submitting pull requests…", "amber");

  try {
    const res = await fetch(`${CONFIG.WORKER_URL}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: state.ghToken,
        token: {
          ...d,
          logoBase64: state.logoBase64,
          logoMimeType: state.logoMimeType,
        },
        registries: targets.map((t) => t.id),
      }),
    });

    const data = await res.json();

    // Animate progress and apply results
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      state.prStatuses[t.id] = "pend";
      renderPRStatus(targets);
      document.getElementById("progBar").style.width = Math.round(((i + 0.5) / targets.length) * 100) + "%";
      await new Promise((r) => setTimeout(r, 400));

      const result = data.results?.[t.id];
      if (result?.success) {
        state.prStatuses[t.id] = "done";
        state.prStatuses[t.id + "_url"] = result.pr_url;
      } else {
        state.prStatuses[t.id] = "err";
        state.prStatuses[t.id + "_err"] = result?.error || "Unknown error";
      }
      renderPRStatus(targets);
      document.getElementById("progBar").style.width = Math.round(((i + 1) / targets.length) * 100) + "%";
    }

    const succeeded = targets.filter((t) => state.prStatuses[t.id] === "done").length;
    const failed = targets.length - succeeded;

    if (failed === 0) {
      setSubmitStatus(`All ${succeeded} PRs opened successfully`, "green");
      document.getElementById("submitBtn").innerHTML = "✓ Submitted!";
    } else {
      setSubmitStatus(`${succeeded} PRs opened, ${failed} failed — see below`, "amber");
      document.getElementById("submitBtn").disabled = false;
      document.getElementById("submitBtn").textContent = "Retry failed";
    }
  } catch (e) {
    setSubmitStatus("Submission failed: " + e.message, "red");
    document.getElementById("submitBtn").disabled = false;
  } finally {
    state.submitting = false;
  }
}

function renderPRStatus(targets) {
  document.getElementById("prStatusRows").innerHTML = targets
    .map((t) => {
      const s = state.prStatuses[t.id] || "idle";
      const badgeMap = { idle: "b-idle", pend: "b-pend", done: "b-done", err: "b-err" };
      const labelMap = { idle: "Queued", pend: "Submitting…", done: "PR opened", err: "Failed" };
      const url = state.prStatuses[t.id + "_url"];
      const errMsg = state.prStatuses[t.id + "_err"];
      return `
        <div class="pr-row">
          <span class="pr-label">${t.name}</span>
          <span class="pr-actions">
            ${url ? `<a href="${url}" target="_blank" rel="noopener" class="pr-link">View PR ↗</a>` : ""}
            ${errMsg ? `<span style="font-size:11px;color:#991b1b">${errMsg}</span>` : ""}
            <span class="badge ${badgeMap[s]}">${labelMap[s]}</span>
          </span>
        </div>`;
    })
    .join("");
}

function setSubmitStatus(msg, color) {
  document.getElementById("submitStatus").innerHTML = `
    <div class="status-dot ${color}"></div>
    <span>${msg}</span>`;
}

// ── JSON preview ────────────────────────────────────────────────────────────────
function showJSON() {
  const d = getForm();
  const entry = {
    chainId: d.chainId,
    address: d.address || "0x0000000000000000000000000000000000000000",
    name: d.name || "My Token",
    symbol: d.symbol || "MYT",
    decimals: d.decimals,
    logoURI: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/${d.address || "0x..."}/logo.png`,
    tags: d.tags.length ? d.tags : ["defi"],
    extensions: {
      ...(d.description && { description: d.description }),
      ...(d.website && { website: d.website }),
      ...(d.twitter && { twitter: d.twitter }),
      ...(d.coingeckoId && { coingeckoId: d.coingeckoId }),
    },
  };
  document.getElementById("jsonOut").textContent = JSON.stringify(entry, null, 2);
  document.getElementById("jsonCard").style.display = "block";
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function getForm() {
  return {
    name: document.getElementById("tokenName").value.trim(),
    symbol: document.getElementById("tokenSymbol").value.trim().toUpperCase(),
    address: document.getElementById("tokenAddress").value.trim(),
    decimals: parseInt(document.getElementById("tokenDecimals").value) || 18,
    chainId: parseInt(document.getElementById("tokenChain").value),
    description: document.getElementById("tokenDesc").value.trim(),
    website: document.getElementById("linkWeb").value.trim(),
    twitter: document.getElementById("linkTwitter").value.trim(),
    discord: document.getElementById("linkDiscord").value.trim(),
    telegram: document.getElementById("linkTelegram").value.trim(),
    github: document.getElementById("linkGithub").value.trim(),
    coingeckoId: document.getElementById("cgId").value.trim(),
    tags: [...state.tags],
  };
}

function showError(msg) {
  console.error(msg);
  alert(msg); // Replace with toast UI in production
}

// ── Init ────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Handle OAuth callback page
  if (window.location.pathname === "/auth/callback") {
    handleOAuthCallback();
    return;
  }

  initUpload();
  initTags();
  renderRegGrid();
});
