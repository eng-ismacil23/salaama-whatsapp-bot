const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_DIR = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');

let qrCodeDataURL = null;
let isReady = false;
let isInitializing = false;
let waState = 'STARTING';
let lastError = null;
let bootAt = Date.now();
let lastQrAt = 0;

function formatPhoneE164(phone) {
  let clean = String(phone).replace(/\D/g, '');
  if (!clean) return null;
  if (clean.startsWith('252')) return clean;
  if (clean.startsWith('0')) clean = clean.slice(1);
  if (clean.length > 9) clean = clean.slice(-9);
  if (clean.length !== 9 || !/^[67]/.test(clean)) return null;
  return '252' + clean;
}

async function deliverMessage(target, message) {
  const sendPromise = client.sendMessage(target, message);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('SendMessage timeout (30s)')), 30000)
  );
  await Promise.race([sendPromise, timeoutPromise]);
}

/** Message Yourself — bot-ku wuxuu u diraa lambarkiisa (admin ogeysiin) */
async function getSelfChatId() {
  const wid = client.info?.wid?._serialized;
  if (wid) return wid;

  const notifyPhone = process.env.BOT_NOTIFY_PHONE && formatPhoneE164(process.env.BOT_NOTIFY_PHONE);
  if (notifyPhone) {
    const numberId = await client.getNumberId(notifyPhone);
    if (numberId) return numberId._serialized;
  }
  return null;
}

function hasStoredSession() {
  try {
    return fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  } catch {
    return false;
  }
}

function clearAuthSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️ Cleared auth session:', AUTH_DIR);
    }
    const cacheDir = path.join(__dirname, '.wwebjs_cache');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to clear auth session:', err.message);
  }
}

const chromeArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
];

const puppeteerOptions = {
  headless: true,
  args: chromeArgs,
};

if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  console.log('Chromium path:', process.env.PUPPETEER_EXECUTABLE_PATH);
} else if (process.platform === 'win32') {
  puppeteerOptions.executablePath =
    'C:\\Users\\hp\\.cache\\puppeteer\\chrome\\win64-150.0.7828.0\\chrome-win64\\chrome.exe';
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
});

async function safeReinitialize(delayMs = 3000, clearSession = false) {
  if (isInitializing) return;
  if (clearSession) {
    console.log('🔄 Manual session reset — clearing auth files');
  }
  isInitializing = true;
  isReady = false;
  qrCodeDataURL = null;
  waState = 'RECONNECTING';

  setTimeout(async () => {
    try {
      if (clearSession) clearAuthSession();
      try {
        await client.destroy();
      } catch (_) {
        /* ok */
      }
      await client.initialize();
    } catch (err) {
      lastError = err.message;
      console.error('Re-initialize failed:', err.message);
      waState = 'ERROR';
    } finally {
      isInitializing = false;
    }
  }, delayMs);
}

client.on('qr', async (qr) => {
  lastQrAt = Date.now();
  waState = 'QR';
  console.log('📱 QR code received — scan via / or /status');
  try {
    qrCodeDataURL = await qrcode.toDataURL(qr);
    isReady = false;
  } catch (err) {
    console.error('QR encode failed:', err.message);
  }
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated');
  waState = 'AUTHENTICATED';
});

client.on('auth_failure', (msg) => {
  console.error('WhatsApp Auth Failure:', msg);
  lastError = String(msg);
  isReady = false;
  qrCodeDataURL = null;
  waState = 'AUTH_FAILURE';
  // Session ha la tirtirin — reconnect kaliya; reset waa /reset-session ama /logout
  safeReinitialize(5000, false);
});

client.on('ready', () => {
  console.log('✅ WhatsApp Bot is Ready!');
  isReady = true;
  isInitializing = false;
  qrCodeDataURL = null;
  waState = 'CONNECTED';
  lastError = null;
});

client.on('loading_screen', (percent, message) => {
  waState = 'LOADING';
  console.log(`⏳ Loading ${percent}% ${message || ''}`);
});

// Reconnect marka xiriirku go'o — session (.wwebjs_auth) waa la hayaa
client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason, '— reconnecting (session kept)');
  isReady = false;
  waState = 'DISCONNECTED';
  safeReinitialize(8000, false);
});

client.on('change_state', (state) => {
  waState = state;
  console.log('WA state:', state);
});

// Reconnect haddii loading uu dheeraado — MA tirtir session otomaatig ah
setInterval(() => {
  if (isReady || isInitializing || qrCodeDataURL) return;
  const elapsed = Date.now() - bootAt;
  if (elapsed < 180000) return;

  console.log('⚠️ Still not ready after 3min — reconnect attempt (session preserved)');
  bootAt = Date.now();
  safeReinitialize(2000, false);
}, 90000);

console.log('🚀 Starting WhatsApp client...', hasStoredSession() ? '(saved session found)' : '(no session — scan QR)');
client.initialize().catch((err) => {
  lastError = err.message;
  console.error('initialize() failed:', err.message, '— retry without clearing session');
  safeReinitialize(8000, false);
});

function buildStatusPage() {
  const statusDiv = isReady
    ? '<div class="status online">&#x1F7E2; Bot is Ready &amp; Connected!</div><p>Fariimaha si otomaatig ah ayay ku baxayaan.</p>'
    : '<div class="status offline">&#x1F534; Not Connected</div><p>Fadlan iskaan garee QR Code-kan hoose adigoo isticmaalaya "Linked Devices" ee WhatsApp-kaaga.</p>';

  let qrSection = '';
  if (qrCodeDataURL) {
    qrSection = '<img src="' + qrCodeDataURL + '" alt="WhatsApp QR Code" />';
  } else if (!isReady) {
    const hint = lastError
      ? '<p class="err">Khalad: ' + lastError + '</p><p><a href="/reset-session">Dib u bilow session</a></p>'
      : '<p>Generating QR code... Please wait and refresh.</p><p><small>Session-ka lama tirtiro ilaa aad adigu /reset-session ama /logout riixdo.</small></p>';
    qrSection = hint;
  }

  const autoRefresh = !isReady
    ? '<script>setTimeout(function(){ window.location.reload(); }, 8000);</script>'
    : '';

  return (
    '<!DOCTYPE html><html lang="so"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Salama WhatsApp Bot Status</title><style>' +
    'body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;color:#1e293b}' +
    '.card{background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 10px 15px -3px rgb(0 0 0/.1);text-align:center;max-width:400px;width:90%}' +
    '.status{padding:.5rem 1rem;border-radius:9999px;font-weight:bold;display:inline-block;margin-bottom:1rem}' +
    '.offline{background:#fee2e2;color:#ef4444}.online{background:#dcfce7;color:#22c55e}' +
    'img{max-width:100%;border-radius:.5rem;margin-top:1rem;border:2px solid #e2e8f0}' +
    'h1{margin-top:0;color:#0f172a}.err{color:#b91c1c;font-size:.85rem}a{color:#2563eb}' +
    '</style>' +
    autoRefresh +
    '</head><body><div class="card"><h1>Salama Bot</h1>' +
    statusDiv +
    qrSection +
    '<p style="font-size:11px;color:#64748b;margin-top:1rem">WA: ' +
    waState +
    (isInitializing ? ' · initializing' : '') +
    '</p></div></body></html>'
  );
}

app.get('/status', (req, res) => {
  res.json({
    isReady,
    waState,
    qrCodeDataURL,
    isInitializing,
    lastError,
    uptime: process.uptime(),
    hasAuthDir: hasStoredSession(),
  });
});

app.get('/reset-session', async (req, res) => {
  console.log('🔄 Reset session requested');
  isReady = false;
  qrCodeDataURL = null;
  bootAt = Date.now();
  await safeReinitialize(500, true);
  if (req.accepts('html')) {
    return res.send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:3rem">' +
        '<h1>Session la tirtiray</h1><p>Sug 30–60 ilbiriqsi, kadib <a href="/">dib u fur boggan</a> si aad u aragto QR.</p>' +
        '<script>setTimeout(()=>location.href="/",45000)</script></body></html>'
    );
  }
  res.json({ success: true, message: 'Session cleared. Wait 30-60s then open / for QR.' });
});

app.post('/reconnect', async (req, res) => {
  bootAt = Date.now();
  await safeReinitialize(500, false);
  res.json({ success: true, message: 'Re-initializing. Check /status for QR.' });
});

app.get('/logout', async (req, res) => {
  try {
    isReady = false;
    qrCodeDataURL = null;
    await client.logout();
    await safeReinitialize(2000, true);
    res.json({ success: true, message: 'Logged out. Wait for new QR at /' });
  } catch (err) {
    await safeReinitialize(2000, true);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send(buildStatusPage());
});

app.post('/send-custom-message', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp bot is not connected. Scan QR at /' });
  }

  const cleanPhone = formatPhoneE164(phone);
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Invalid Somalia phone: ' + phone });
  }

  try {
    const numberId = await client.getNumberId(cleanPhone);
    if (!numberId) {
      return res.status(404).json({
        error: 'Lambarkan WhatsApp ma leh ama ma saxna',
        details: `Hubi in ${cleanPhone} uu WhatsApp ku jiro`,
        phone: cleanPhone,
      });
    }

    await deliverMessage(numberId._serialized, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message, phone: cleanPhone });
  }
});

/** Ogeysiin admin — Message Yourself (bot → naftiisa) marka welcome ama arday cusub fashilmo */
app.post('/notify-admin', async (req, res) => {
  const { message, studentName, phone, reason } = req.body || {};

  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp bot is not connected. Scan QR at /' });
  }

  const text =
    message ||
    [
      '⚠️ *Salama HUB — Ogeysiin*',
      '',
      studentName ? `*Arday*: ${studentName}` : null,
      phone ? `📞 *Telefoon*: ${phone}` : null,
      reason ? `❌ *Sabab*: ${reason}` : null,
      '',
      'Fadlan hubi lambarka WhatsApp-ka ama Bot-ka.',
    ]
      .filter(Boolean)
      .join('\n');

  if (!text.trim()) {
    return res.status(400).json({ error: 'message or (studentName + reason) required' });
  }

  try {
    const selfId = await getSelfChatId();
    if (!selfId) {
      return res.status(500).json({
        error: 'Lambarka bot-ka lama helin. Ku dar BOT_NOTIFY_PHONE Railway env (tusaale: 619829438)',
      });
    }

    await deliverMessage(selfId, text);
    console.log('📩 Admin notify (message yourself) sent');
    res.json({ success: true, mode: 'message-yourself' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to notify admin', details: error.message });
  }
});

app.post('/send-welcome', async (req, res) => {
  const { phone, studentName } = req.body;
  if (!phone || !studentName) {
    return res.status(400).json({ error: 'Phone and studentName are required' });
  }
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp bot is not connected. Scan QR at /' });
  }

  const cleanPhone = formatPhoneE164(phone);
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Invalid Somalia phone: ' + phone });
  }

  const message = [
    '🎓 Ku Soo Dhawoow SALAAMA LEARNING HUB ' + studentName + '! 🚀',
    '',
    'Waxaad hadda qaaday tallaabadii ugu muhiimsaneyd ee guushaada waxbarasho.',
    'Halkaan waxaad ka heli doontaa buugaagta manhajka, su\'aalo & jawaabo, quiz maalinle ah,',
    'iyo diyaarinta imtixaanka dowladda si heer sare ah.',
    '',
    '📚 Baro si fudud',
    '📝 Is tijaabi maalin walba',
    '🏆 U diyaar garow guul dhab ah',
    '',
    'Mustaqbalkaaga maanta ayuu bilaabanayaa — Ku dadaal, ku guuleyso! 🌟',
  ].join('\n');

  try {
    const numberId = await client.getNumberId(cleanPhone);
    if (!numberId) {
      return res.status(404).json({
        error: 'Lambarkan WhatsApp ma leh ama ma saxna',
        details: `Hubi in ${cleanPhone} uu WhatsApp ku jiro`,
        phone: cleanPhone,
      });
    }

    await deliverMessage(numberId._serialized, message);
    res.json({ success: true, message: 'Message sent successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message', details: error.message, phone: cleanPhone });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT);
});
