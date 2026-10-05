# Salama WhatsApp Bot — Railway

## 1. Railway Settings (muhiim!)

| Setting | Value |
|---------|--------|
| **Root Directory** | `whatsapp-bot` |
| **Start Command** | `npm start` |
| **Health** | Deploy kadib fur `/status` |

Haddii Root Directory uu yahay repo root (`.`), Railway wuxuu build-gareynaa React app — bot-ku ma shaqeynayo si sax ah.

## 2. Push GitHub

```bash
cd whatsapp-bot
git add index.js nixpacks.toml railway.toml RAILWAY.md package.json
git commit -m "fix: Railway QR + session reset + puppeteer"
git push origin main
```

Railway wuxuu auto-deploy gareynaa push kadib.

## 3. QR ma imaanayo?

1. Fur Railway dashboard → service-kaaga → **Settings** → copy **Public URL**
2. Fur: `YOUR_BOT_URL/reset-session`
3. Sug **45–90 ilbiriqsi**
4. Fur: `YOUR_BOT_URL/`
5. WhatsApp → **Linked devices** → Scan QR
6. Railway → **Restart** service haddii weli QR uusan imaan

## 4. Netlify

Netlify → Environment variables:

`BOT_API_URL` = URL-ka Railway bot-kaaga (tusaale: `https://your-service.up.railway.app`)

**Ha gelin URL-ka bot-ka file-yada code-ka** — env var kaliya.

## 4b. Message Yourself (ogeysiin marka welcome fashilmo)

Railway → **Variables** (whatsapp-bot service):

| Variable | Value |
|----------|--------|
| `BOT_NOTIFY_PHONE` | `619829438` (lambarkaaga WhatsApp — Message Yourself) |

Marka welcome-ku fashilmo, bot-ku wuxuu kuu dirayaa fariin **Message Yourself** chat-kaaga.

## 5. Session ha lumin deploy/restart (MUHIIM!)

Haddii Volume la'aan, QR waa inaad mar kale iskaan gareysaa **deploy kasta**.

Railway → Service → **Volumes** → Add Volume:
- **Mount path:** `/app/.wwebjs_auth`
- **Variable:** `WWEBJS_AUTH_PATH=/app/.wwebjs_auth`

Marka QR la iskaan gareeyo, session-ku wuu **sii jiraa** ilaa aad adigu:
- `/logout` ama Admin → **Logout / Reset Bot**
- `/reset-session`

Bot-ku **ma tirtiro** session otomaatig ah (watchdog waa la saaray).
