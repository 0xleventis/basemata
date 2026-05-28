/**
 * Cloudflare Worker — Base Token Registry Submitter
 * Handles GitHub OAuth exchange + pull request creation
 *
 * Environment variables (set in Cloudflare dashboard / wrangler.toml secrets):
 *   GITHUB_CLIENT_ID      — from your GitHub OAuth App
 *   GITHUB_CLIENT_SECRET  — from your GitHub OAuth App
 *   ALLOWED_ORIGIN        — your frontend domain e.g. https://tokenregistry.xyz
 */

const CORS = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
});

const json = (data, status = 200, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS(origin) },
  });

// Registry PR configs — branch name, file path, and PR body template per registry
const REGISTRIES = {
  uniswap: {
    owner: "Uniswap",
    repo: "default-token-list",
    branch: "main",
    tokenListPath: "src/tokens/base.json",
    logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} token (Base)`,
  },
  aerodrome: {
    owner: "aerodrome-finance",
    repo: "tokenlist",
    branch: "main",
    tokenListPath: "src/tokens/base.json",
    logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} to Base token list`,
  },
  baseswap: {
    owner: "BaseSwapDex",
    repo: "token-list",
    branch: "main",
    tokenListPath: "baseswap-default.tokenlist.json",
    logoDir: "logos",
    prTitle: (sym) => `[Token Request] ${sym} on Base`,
  },
  coinbase: {
    owner: "coinbase",
    repo: "node-wallets-ecosystem-token-list",
    branch: "main",
    tokenListPath: "src/tokens/base.json",
    logoDir: "src/logos",
    prTitle: (sym) => `Add ${sym} token to Base list`,
  },
  sushi: {
    owner: "sushiswap",
    repo: "default-token-list",
    branch: "master",
    tokenListPath: "packages/default-token-list/src/tokens/base.json",
    logoDir: "packages/default-token-list/src/logos",
    prTitle: (sym) => `feat: add ${sym} to Base token list`,
  },
  trust: {
    owner: "trustwallet",
    repo: "assets",
    branch: "master",
    tokenListPath: null, // Trust Wallet uses per-token folder structure
    logoDir: `blockchains/base/assets`,
    prTitle: (sym) => `Add ${sym} token on Base blockchain`,
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || env.ALLOWED_ORIGIN || "*";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS(origin) });
    }

    // ── Routes ──────────────────────────────────────────────────────────────

    // GET /auth/callback?code=xxx&state=xxx
    // Exchange GitHub OAuth code for access token
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) return json({ error: "Missing code" }, 400, origin);

      try {
        const tokenRes = await fetch(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code,
            }),
          }
        );
        const tokenData = await tokenRes.json();
        if (tokenData.error) {
          return json({ error: tokenData.error_description }, 400, origin);
        }

        // Fetch user profile
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "User-Agent": "TokenRegistryApp/1.0",
          },
        });
        const user = await userRes.json();

        return json(
          {
            access_token: tokenData.access_token,
            user: {
              login: user.login,
              name: user.name,
              avatar_url: user.avatar_url,
              html_url: user.html_url,
            },
          },
          200,
          origin
        );
      } catch (e) {
        return json({ error: "OAuth exchange failed", detail: e.message }, 500, origin);
      }
    }

    // POST /submit
    // Create fork + branch + PR for each selected registry
    if (url.pathname === "/submit" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, origin);
      }

      const { access_token, token, registries } = body;
      if (!access_token) return json({ error: "Not authenticated" }, 401, origin);
      if (!token?.address || !token?.name || !token?.symbol) {
        return json({ error: "Missing token fields" }, 400, origin);
      }
      if (!registries?.length) return json({ error: "No registries selected" }, 400, origin);

      const gh = (path, opts = {}) =>
        fetch(`https://api.github.com${path}`, {
          ...opts,
          headers: {
            Authorization: `Bearer ${access_token}`,
            "User-Agent": "TokenRegistryApp/1.0",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            ...(opts.headers || {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then((r) => r.json());

      // Get authenticated user login
      const me = await gh("/user");
      if (me.message) return json({ error: "Invalid token", detail: me.message }, 401, origin);

      const results = {};

      for (const regId of registries) {
        const reg = REGISTRIES[regId];
        if (!reg) { results[regId] = { error: "Unknown registry" }; continue; }

        try {
          // 1. Fork the repo (idempotent)
          const fork = await gh(`/repos/${reg.owner}/${reg.repo}/forks`, {
            method: "POST",
            body: { default_branch_only: true },
          });
          const forkOwner = me.login;
          const forkRepo = fork.name || reg.repo;

          // Wait briefly for fork to be ready
          await new Promise((r) => setTimeout(r, 2000));

          // 2. Get default branch SHA
          const baseRef = await gh(
            `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${reg.branch}`
          );
          const baseSha = baseRef?.object?.sha;
          if (!baseSha) throw new Error("Could not get base branch SHA");

          // 3. Create new branch
          const branchName = `add-token-${token.symbol.toLowerCase()}-${Date.now()}`;
          await gh(`/repos/${forkOwner}/${forkRepo}/git/refs`, {
            method: "POST",
            body: { ref: `refs/heads/${branchName}`, sha: baseSha },
          });

          const files = [];

          // 4. Build the token entry JSON
          const tokenEntry = buildTokenEntry(token, regId);

          // 5. For Trust Wallet: create logo.png file in token folder
          if (regId === "trust") {
            if (token.logoBase64) {
              files.push({
                path: `${reg.logoDir}/${token.address}/logo.png`,
                content: token.logoBase64, // already base64
                encoding: "base64",
              });
            }
            // Trust Wallet also needs info/info.json
            files.push({
              path: `${reg.logoDir}/${token.address}/info.json`,
              content: btoa(JSON.stringify({
                name: token.name,
                website: token.website || "",
                description: token.description || "",
                explorer: `https://basescan.org/token/${token.address}`,
                research: "",
                coin_type: 8453,
                status: "active",
                rpc_url: "https://mainnet.base.org",
                tags: token.tags || [],
                links: buildLinks(token),
              }, null, 2)),
              encoding: "base64",
            });
          } else {
            // For all other registries: update token list JSON + upload logo
            if (token.logoBase64) {
              const ext = token.logoMimeType === "image/svg+xml" ? "svg" : "png";
              files.push({
                path: `${reg.logoDir}/${token.address}.${ext}`,
                content: token.logoBase64,
                encoding: "base64",
              });
            }
            // Fetch existing token list and append
            if (reg.tokenListPath) {
              const existingFile = await gh(
                `/repos/${forkOwner}/${forkRepo}/contents/${reg.tokenListPath}?ref=${branchName}`
              );
              let tokenList = [];
              let fileSha = null;
              if (existingFile?.content) {
                fileSha = existingFile.sha;
                try {
                  tokenList = JSON.parse(atob(existingFile.content.replace(/\n/g, "")));
                  if (!Array.isArray(tokenList)) tokenList = tokenList.tokens || [];
                } catch { tokenList = []; }
              }
              // Remove duplicate if already exists
              tokenList = tokenList.filter(
                (t) => t.address?.toLowerCase() !== token.address.toLowerCase()
              );
              tokenList.push(tokenEntry);

              files.push({
                path: reg.tokenListPath,
                content: btoa(JSON.stringify(tokenList, null, 2)),
                encoding: "base64",
                sha: fileSha,
              });
            }
          }

          // 6. Commit all files
          for (const file of files) {
            const payload = {
              message: `Add ${token.symbol} token (${token.address})`,
              content: file.content,
              branch: branchName,
            };
            if (file.sha) payload.sha = file.sha;
            await gh(
              `/repos/${forkOwner}/${forkRepo}/contents/${file.path}`,
              { method: "PUT", body: payload }
            );
          }

          // 7. Open pull request on upstream repo
          const pr = await gh(`/repos/${reg.owner}/${reg.repo}/pulls`, {
            method: "POST",
            body: {
              title: reg.prTitle(token.symbol),
              head: `${forkOwner}:${branchName}`,
              base: reg.branch,
              body: buildPRBody(token, regId),
            },
          });

          results[regId] = {
            success: true,
            pr_url: pr.html_url,
            pr_number: pr.number,
          };
        } catch (e) {
          results[regId] = { error: e.message };
        }
      }

      return json({ results }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};

function buildTokenEntry(token, regId) {
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
      ...(token.coinmarketcapId && { coinmarketcapId: token.coinmarketcapId }),
    },
  };
}

function buildLinks(token) {
  const links = [];
  if (token.website) links.push({ name: "Website", url: token.website });
  if (token.twitter) links.push({ name: "Twitter", url: token.twitter });
  if (token.discord) links.push({ name: "Discord", url: token.discord });
  if (token.telegram) links.push({ name: "Telegram", url: token.telegram });
  if (token.github) links.push({ name: "GitHub", url: token.github });
  return links;
}

function buildPRBody(token, regId) {
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
${token.website ? `- 🌐 Website: ${token.website}` : ""}
${token.twitter ? `- 🐦 Twitter: ${token.twitter}` : ""}
${token.discord ? `- 💬 Discord: ${token.discord}` : ""}

### Description
${token.description || "_No description provided._"}

### Checklist
- [x] Token contract is verified on BaseScan
- [x] Logo is 256×256px PNG or SVG
- [x] Logo file size under 100KB
- [x] Token is live on Base mainnet
- [x] Submitted via [Base Token Registry](https://tokenregistry.xyz)

---
*Submitted via the Base Token Registry Submitter*`;
}
