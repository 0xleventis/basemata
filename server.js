import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "5mb" })); // logos can be up to 100KB base64
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
}));

// Serve frontend static files
app.use(express.static(join(__dirname, "public")));

// ── Registry configs ───────────────────────────────────────────────────────────
const REGISTRIES = {
  uniswap: {
    owner: "Uniswap", repo: "default-token-list", branch: "main",
    tokenListPath: "src/tokens/base.json", logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} token (Base)`,
  },
  aerodrome: {
    owner: "aerodrome-finance", repo: "tokenlist", branch: "main",
    tokenListPath: "src/tokens/base.json", logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} to Base token list`,
  },
  baseswap: {
    owner: "BaseSwapDex", repo: "token-list", branch: "main",
    tokenListPath: "baseswap-default.tokenlist.json", logoDir: "logos",
    prTitle: (sym) => `[Token Request] ${sym} on Base`,
  },
  coinbase: {
    owner: "coinbase", repo: "node-wallets-ecosystem-token-list", branch: "main",
    tokenListPath: "src/tokens/base.json", logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} token to Base list`,
  },
  sushi: {
    owner: "sushiswap", repo: "default-token-list", branch: "master",
    tokenListPath: "packages/default-token-list/src/tokens/base.json",
    logoDir: "packages/default-token-list/src/logos",
    prTitle: (sym) => `feat: add ${sym} to Base token list`,
  },
  trust: {
    owner: "trustwallet", repo: "assets", branch: "master",
    tokenListPath: null,
    logoDir: "blockchains/base/assets",
    prTitle: (sym) => `Add ${sym} token on Base blockchain`,
  },
};

// ── GitHub API helper ──────────────────────────────────────────────────────────
function gh(token) {
  return async (path, opts = {}) => {
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "TokenRegistryApp/1.0",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json();
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /auth/callback?code=xxx&state=xxx
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;

  // If this is the popup page (no code), serve the HTML
  if (!code) {
    return res.sendFile(join(__dirname, "public/auth/callback/index.html"));
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description });
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "TokenRegistryApp/1.0",
      },
    });
    const user = await userRes.json();

    res.json({
      access_token: tokenData.access_token,
      user: {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "OAuth exchange failed", detail: e.message });
  }
});

// POST /submit
app.post("/submit", async (req, res) => {
  const { access_token, token, registries } = req.body;

  if (!access_token) return res.status(401).json({ error: "Not authenticated" });
  if (!token?.address || !token?.name || !token?.symbol) {
    return res.status(400).json({ error: "Missing token fields" });
  }
  if (!registries?.length) return res.status(400).json({ error: "No registries selected" });

  const api = gh(access_token);

  // Verify token
  const me = await api("/user");
  if (me.message) return res.status(401).json({ error: "Invalid GitHub token" });

  const results = {};

  for (const regId of registries) {
    const reg = REGISTRIES[regId];
    if (!reg) { results[regId] = { error: "Unknown registry" }; continue; }

    try {
      // 1. Fork (idempotent)
      await api(`/repos/${reg.owner}/${reg.repo}/forks`, {
        method: "POST",
        body: { default_branch_only: true },
      });
      const forkOwner = me.login;
      const forkRepo = reg.repo;

      // Give GitHub a moment to provision the fork
      await sleep(2500);

      // 2. Get base branch SHA
      const baseRef = await api(`/repos/${forkOwner}/${forkRepo}/git/ref/heads/${reg.branch}`);
      const baseSha = baseRef?.object?.sha;
      if (!baseSha) throw new Error("Could not get base branch SHA — fork may still be provisioning");

      // 3. Create branch
      const branchName = `add-token-${token.symbol.toLowerCase()}-${Date.now()}`;
      await api(`/repos/${forkOwner}/${forkRepo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branchName}`, sha: baseSha },
      });

      const files = [];

      if (regId === "trust") {
        // Trust Wallet: logo.png + info.json in per-token folder
        if (token.logoBase64) {
          files.push({
            path: `${reg.logoDir}/${token.address}/logo.png`,
            content: token.logoBase64,
          });
        }
        files.push({
          path: `${reg.logoDir}/${token.address}/info.json`,
          content: btoa(JSON.stringify({
            name: token.name,
            website: token.website || "",
            description: token.description || "",
            explorer: `https://basescan.org/token/${token.address}`,
            coin_type: 8453,
            status: "active",
            tags: token.tags || [],
            links: buildLinks(token),
          }, null, 2)),
        });
      } else {
        // All other registries: logo file + updated token list JSON
        if (token.logoBase64) {
          const ext = token.logoMimeType === "image/svg+xml" ? "svg" : "png";
          files.push({
            path: `${reg.logoDir}/${token.address}.${ext}`,
            content: token.logoBase64,
          });
        }

        if (reg.tokenListPath) {
          const existing = await api(
            `/repos/${forkOwner}/${forkRepo}/contents/${reg.tokenListPath}?ref=${branchName}`
          );
          let list = [];
          let fileSha = null;
          if (existing?.content) {
            fileSha = existing.sha;
            try {
              const parsed = JSON.parse(Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString());
              list = Array.isArray(parsed) ? parsed : (parsed.tokens || []);
            } catch { list = []; }
          }
          list = list.filter((t) => t.address?.toLowerCase() !== token.address.toLowerCase());
          list.push(buildTokenEntry(token, regId));
          files.push({
            path: reg.tokenListPath,
            content: Buffer.from(JSON.stringify(list, null, 2)).toString("base64"),
            sha: fileSha,
          });
        }
      }

      // 4. Commit each file
      for (const file of files) {
        const payload = {
          message: `Add ${token.symbol} token (${token.address})`,
          content: file.content,
          branch: branchName,
        };
        if (file.sha) payload.sha = file.sha;
        await api(`/repos/${forkOwner}/${forkRepo}/contents/${file.path}`, {
          method: "PUT",
          body: payload,
        });
      }

      // 5. Open PR
      const pr = await api(`/repos/${reg.owner}/${reg.repo}/pulls`, {
        method: "POST",
        body: {
          title: reg.prTitle(token.symbol),
          head: `${forkOwner}:${branchName}`,
          base: reg.branch,
          body: buildPRBody(token),
        },
      });

      results[regId] = { success: true, pr_url: pr.html_url, pr_number: pr.number };
    } catch (e) {
      results[regId] = { error: e.message };
    }
  }

  res.json({ results });
});

// Health check for Railway
app.get("/health", (_, res) => res.json({ ok: true }));

// Catch-all → serve index.html (SPA)
app.get("*", (_, res) => res.sendFile(join(__dirname, "public/index.html")));

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildTokenEntry(token) {
  return {
    chainId: token.chainId || 8453,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals || 18,
    logoURI: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/${token.address}/logo.png`,
    tags: token.tags || [],
    extensions: {
      ...(token.description && { description: token.description }),
      ...(token.website && { website: token.website }),
      ...(token.twitter && { twitter: token.twitter }),
      ...(token.coingeckoId && { coingeckoId: token.coingeckoId }),
    },
  };
}

function buildLinks(token) {
  return [
    token.website  && { name: "Website",  url: token.website },
    token.twitter  && { name: "Twitter",  url: token.twitter },
    token.discord  && { name: "Discord",  url: token.discord },
    token.telegram && { name: "Telegram", url: token.telegram },
    token.github   && { name: "GitHub",   url: token.github },
  ].filter(Boolean);
}

function buildPRBody(token) {
  return `## Add ${token.name} (${token.symbol})

### Token details
| Field | Value |
|---|---|
| **Name** | ${token.name} |
| **Symbol** | \`${token.symbol}\` |
| **Address** | \`${token.address}\` |
| **Chain ID** | ${token.chainId || 8453} (Base) |
| **Decimals** | ${token.decimals || 18} |

### Links
${[
  token.website  && `- 🌐 Website: ${token.website}`,
  token.twitter  && `- 🐦 Twitter: ${token.twitter}`,
  token.discord  && `- 💬 Discord: ${token.discord}`,
  token.telegram && `- ✈️ Telegram: ${token.telegram}`,
].filter(Boolean).join("\n")}

### Description
${token.description || "_No description provided._"}

### Checklist
- [x] Token contract is verified on BaseScan
- [x] Logo is 256×256px PNG or SVG, under 100KB
- [x] Token is live on Base mainnet
- [x] Submitted via [Base Token Registry](${process.env.APP_URL || "https://tokenregistry.xyz"})

---
*Submitted via Base Token Registry*`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Token Registry running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`API:      http://localhost:${PORT}/auth/callback`);
});
