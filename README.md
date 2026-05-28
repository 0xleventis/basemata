# Base Token Registry — Railway deployment

One command to deploy. Railway runs the Express server that handles GitHub OAuth,
on-chain validation, and PR creation — and serves the frontend from the same URL.

---

## Deploy in 5 minutes

### 1. Create a GitHub OAuth App

1. Go to https://github.com/settings/developers → **New OAuth App**
2. Fill in:
   - **Application name**: Base Token Registry
   - **Homepage URL**: `https://your-app.up.railway.app` *(update after first deploy)*
   - **Authorization callback URL**: `https://your-app.up.railway.app/auth/callback`
3. Copy the **Client ID** — you'll need it in step 3
4. Click **Generate a new client secret** — copy it too

---

### 2. Deploy to Railway

**Option A — GitHub (recommended):**
1. Push this folder to a new GitHub repo
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
3. Select your repo — Railway auto-detects Node.js and deploys

**Option B — Railway CLI:**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

### 3. Set environment variables

In Railway dashboard → your service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `GITHUB_CLIENT_ID` | From your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | From your GitHub OAuth App |
| `APP_URL` | Your Railway URL e.g. `https://token-registry-production.up.railway.app` |
| `ALLOWED_ORIGIN` | Same as APP_URL |

Railway injects `PORT` automatically — no need to set it.

---

### 4. Set your GitHub Client ID in the frontend

Edit `public/js/app.js` line 8:
```js
GITHUB_CLIENT_ID: "paste_your_client_id_here",
```

Then redeploy (push to GitHub or run `railway up` again).

---

### 5. Update GitHub OAuth App callback URL

Go back to your GitHub OAuth App settings and update the callback URL to your
actual Railway URL: `https://your-app.up.railway.app/auth/callback`

---

## Local development

```bash
cp .env.example .env
# Fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET

npm install
npm run dev
# App runs at http://localhost:3000
```

---

## How it works

Railway runs a single Express server that:
- Serves `public/` as static files (frontend)
- `GET /auth/callback` — exchanges GitHub OAuth code for access token
- `POST /submit` — forks registries, commits logo + token list entry, opens PRs
- `GET /health` — Railway health check

Both frontend and API run on the same domain so no CORS configuration is needed
beyond setting `ALLOWED_ORIGIN`.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `APP_URL` | Recommended | Your public app URL (used in PR body) |
| `ALLOWED_ORIGIN` | Optional | Restrict CORS (defaults to `*`) |
| `PORT` | Auto | Set by Railway automatically |
