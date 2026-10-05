/**
 * Recovery bulk: hubi users → diiwaan geli kuwa maqan → WhatsApp toos (local session).
 *
 *   cd whatsapp-bot
 *   node bulk-send.js
 *
 * Flags:
 *   --dry-run        Hubi fariimaha (default: raali galin kaliya)
 *   --send-only      Ha diiwaan gelin, dir kaliya
 *   --apology-only   Kaliya arday hore (raali galin) — 84
 *   --recovery-only  Kaliya 42-cusub (xogta + password) — 36
 *   --all            Dry-run: muuji dhammaan (raali + cusub)
 *   --resume         Ka sii wad — ha dib u dirin kuwa horey u diray
 *
 * Ctrl+C hal mar = jooji, progress waa la kaydiyaa (--resume marka xigta)
 *
 * Fariimaha (121 arday, admin lama diro):
 *   - 79 hore (aan liiska 42 ku jirin) → raali galin + updates + link
 *   - 36 Arday Salama (42-ka) → telefoon + password + updates + beddel fasalka (2×) + link
 *   - 6 magac dhab (42-ka) → raali galin + updates + link (password hore)
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const { neon } = require('@neondatabase/serverless');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { hashPassword } = require('../netlify/functions/password-utils');
const { normalizePhone, phonesMatch } = require('../scripts/phone-utils');
const {
  resolveAppLink,
  CANONICAL_APP_LINK,
  messageApologyUpdates,
  messageRecovery42,
} = require('../scripts/whatsapp-messages');

const DATABASE_URL = process.env.DATABASE_URL;
const APP_LINK = resolveAppLink();
const DEFAULT_NAME = 'Arday Salama';
const DEFAULT_GRADE = '8aad';
const WARMUP_MS = 12000;
const SEND_DELAY_MS = 6000;
const MAX_SEND_RETRIES = 3;
const RETRY_DELAY_MS = 10000;
const PROGRESS_PATH = path.join(__dirname, '../scripts/output/bulk-send-progress.json');

const RAW_NUMBERS = `
619814607, 61616862739, 619371968, 619324094, 616082098, 623719718, 616897332,
618296176, 618371187, 687051784, 702084370, 615999496, 611430957, 617067086,
682093043, 617962930, 613832202, 629006358, 615096717, 702311685, 687051117,
687795086, 617573345, 612283938, 615787878, 617580784, 613405749, 619251530,
617548257, 612484305, 686820971, 61686920971, 616779391, 612661838, 616783043,
619694979, 612725719, 612847252, 626897332, 614441819, 610426221, 686472173
`;

const DRY_RUN = process.argv.includes('--dry-run');
const SEND_ONLY = process.argv.includes('--send-only');
const SHOW_ALL = process.argv.includes('--all');
const RECOVERY_ONLY = process.argv.includes('--recovery-only');
const APOLOGY_ONLY =
  !RECOVERY_ONLY && (process.argv.includes('--apology-only') || (DRY_RUN && !SHOW_ALL));
const RESUME = process.argv.includes('--resume');

let sendingStarted = false;
let abortRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waChatId(e164) {
  const digits = String(e164).replace(/\D/g, '');
  return `${digits}@c.us`;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
      return { sent: new Set(data.sent || []), meta: data };
    }
  } catch {
    /* ignore */
  }
  return { sent: new Set(), meta: {} };
}

function saveProgress(sentSet, extra = {}) {
  const outDir = path.dirname(PROGRESS_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    PROGRESS_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        sent: [...sentSet],
        ...extra,
      },
      null,
      2
    )
  );
}

function isRetryableWaError(msg) {
  return /comms|startComms|Protocol error|Execution context|Session closed/i.test(
    String(msg || '')
  );
}

function makePassword(localNine) {
  return `Salama${localNine.slice(-6)}`;
}

function isStaffOrAdmin(user) {
  const role = (user?.role || '').toLowerCase();
  return role === 'admin' || role === 'staff';
}

function isInRecoveryList(user, recoveryLocals) {
  if (!user) return false;
  return recoveryLocals.some((local) => phonesMatch(user.phone, local));
}

/** 42-ka: Arday Salama → fariin buuxda + beddel fasalka 2× */
function isRecovery42Full(user, recoveryLocals) {
  if (!user || isStaffOrAdmin(user)) return false;
  return (
    isInRecoveryList(user, recoveryLocals) &&
    (user.full_name || '').trim() === DEFAULT_NAME
  );
}

function parseTargetNumbers() {
  const list = [];
  const seen = new Set();
  for (const raw of RAW_NUMBERS.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const n = normalizePhone(raw);
    if (!n) {
      console.warn(`⚠️ Lama aqoonsan: ${raw}`);
      continue;
    }
    if (seen.has(n.local)) continue;
    seen.add(n.local);
    list.push({ raw, ...n });
  }
  return list;
}

async function findUserByPhone(sql, allUsers, normalized) {
  for (const u of allUsers) {
    if (phonesMatch(u.phone, normalized.e164)) return u;
  }
  const rows = await sql`
    SELECT id, full_name, phone, status, grade
    FROM users WHERE phone LIKE ${'%' + normalized.local} LIMIT 5
  `;
  for (const u of rows) {
    if (phonesMatch(u.phone, normalized.e164)) return u;
  }
  return null;
}

/** Diiwaan geli 42-ka + diyaari fariimaha 121 arday */
async function prepareRecipients() {
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL ma jiro .env');
    process.exit(1);
  }

  const sql = neon(DATABASE_URL);
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_batch BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS grade_change_count INTEGER DEFAULT 0`;
  } catch (e) {
    console.warn('⚠️ Columns:', e.message);
  }

  const targets = parseTargetNumbers();
  const recoveryLocals = targets.map((t) => t.local);
  const targetByLocal = new Map(targets.map((t) => [t.local, t]));
  console.log(`📋 Liiska recovery: ${targets.length} lambar`);
  console.log(`🔗 Link (sax): ${APP_LINK}`);
  if (APP_LINK !== CANONICAL_APP_LINK) {
    console.log(`   (canonical: ${CANONICAL_APP_LINK})`);
  }

  let allUsers = await sql`
    SELECT id, full_name, phone, status, grade, role, recovery_batch, grade_change_count
    FROM users
  `;
  const report = { registered: [], recovery42: [], apology: [], skipped: [], failed: [] };

  if (!SEND_ONLY) {
    for (const item of targets) {
      let user = await findUserByPhone(sql, allUsers, item);
      if (user && isStaffOrAdmin(user)) {
        report.skipped.push({ display: item.display, reason: 'admin/staff' });
        continue;
      }
      if (!user) {
        const password = makePassword(item.local);
        if (DRY_RUN) {
          report.registered.push({ display: item.display, password, dryRun: true });
          console.log(`✅ [dry-run] Diiwaan: ${item.display}`);
          continue;
        }
        const hash = await hashPassword(password);
        try {
          const inserted = await sql`
            INSERT INTO users (full_name, phone, email, password_hash, role, status, grade, recovery_batch, grade_change_count)
            VALUES (${DEFAULT_NAME}, ${item.dbPhone}, null, ${hash}, 'student', 'active', ${DEFAULT_GRADE}, true, 0)
            RETURNING id, full_name, phone, status, grade, role
          `;
          user = inserted[0];
          allUsers.push(user);
          await sql`
            INSERT INTO payments (user_id, phone, amount, status, grade)
            VALUES (${user.id}, ${item.dbPhone}, 0, 'approved', ${DEFAULT_GRADE})
          `;
          report.registered.push({ display: item.display, password });
          console.log(`✅ Diiwaan cusub: ${item.display} → ${password}`);
        } catch (e) {
          report.failed.push({ display: item.display, error: e.message });
          console.error(`❌ ${item.display}:`, e.message);
        }
      }
    }
    allUsers = await sql`
      SELECT id, full_name, phone, status, grade, role, recovery_batch, grade_change_count
      FROM users
    `;
  }

  const recipients = [];
  const students = allUsers.filter((u) => (u.role || '').toLowerCase() === 'student');

  console.log(`\n📤 Diyaarinta fariimaha ${students.length} arday...\n`);

  for (const user of students) {
    const norm = normalizePhone(user.phone);
    if (!norm) {
      report.skipped.push({ phone: user.phone, reason: 'phone invalid' });
      continue;
    }

    const item = targetByLocal.get(norm.local) || {
      display: norm.display,
      e164: norm.e164,
      local: norm.local,
    };

    if (isRecovery42Full(user, recoveryLocals)) {
      const password = makePassword(norm.local);
      if (!DRY_RUN && !SEND_ONLY) {
        const hash = await hashPassword(password);
        await sql`
          UPDATE users
          SET password_hash = ${hash}, status = 'active', recovery_batch = true, grade_change_count = 0
          WHERE id = ${user.id}
        `;
      } else if (!DRY_RUN) {
        await sql`
          UPDATE users SET recovery_batch = true, grade_change_count = 0 WHERE id = ${user.id}
        `.catch(() => {});
      }

      const msg = messageRecovery42(item.dbPhone, password, APP_LINK);
      report.recovery42.push({ display: item.display, password });
      if (!APOLOGY_ONLY) {
        console.log(`🔑 42-cusub: ${item.display} → ${password}`);
      }
      recipients.push({
        waId: item.e164,
        display: item.display,
        message: msg,
        kind: 'recovery42',
      });
    } else {
      const msg = messageApologyUpdates(user.full_name, APP_LINK);
      const in42 = isInRecoveryList(user, recoveryLocals);
      report.apology.push({
        display: norm.display,
        name: user.full_name,
        inRecoveryList: in42,
      });
      if (!RECOVERY_ONLY) {
        console.log(
          `🙏 Raali+updates: ${norm.display} (${user.full_name})${in42 ? ' [42]' : ' [79]'}`
        );
      }
      recipients.push({
        waId: norm.e164,
        display: norm.display,
        message: msg,
        kind: 'apology',
      });
    }
  }

  const outDir = path.join(__dirname, '../scripts/output');
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `bulk-send-prep-${Date.now()}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        report,
        summary: {
          total: recipients.length,
          recovery42: report.recovery42.length,
          apology: report.apology.length,
        },
        link: APP_LINK,
      },
      null,
      2
    )
  );
  let out = recipients;
  if (APOLOGY_ONLY) out = recipients.filter((r) => r.kind === 'apology');
  if (RECOVERY_ONLY) out = recipients.filter((r) => r.kind === 'recovery42');

  console.log(`\n📝 Report: ${reportPath}`);
  if (!APOLOGY_ONLY) console.log(`   🔑 42-cusub (full):  ${report.recovery42.length}`);
  if (!RECOVERY_ONLY) console.log(`   🙏 Raali+updates:    ${report.apology.length}`);
  console.log(`   📤 La dirayaa:        ${out.length}`);
  console.log(`   ⏭️ Skip:             ${report.skipped.length}`);
  console.log(`   🔗 Link:             ${APP_LINK}`);
  if (APOLOGY_ONLY && DRY_RUN) {
    console.log('\n   ℹ️ Dry-run: raali galin kaliya. Cusub: --recovery-only ama --all');
  }
  console.log('');

  return out;
}

let recipientsToSend = [];
let prepDone = false;
let waReady = false;

function fileExists(p) {
  try {
    return p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Chrome for whatsapp-web.js — system Chrome first (avoids broken Puppeteer cache). */
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fileExists(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const winCandidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of winCandidates) {
    if (fileExists(p)) return p;
  }
  try {
    const puppeteer = require('puppeteer');
    const bundled = puppeteer.executablePath();
    if (fileExists(bundled)) return bundled;
  } catch {
    /* ignore */
  }
  const cache146 = path.join(
    process.env.USERPROFILE || '',
    '.cache',
    'puppeteer',
    'chrome',
    'win64-146.0.7680.31',
    'chrome-win64',
    'chrome.exe'
  );
  if (fileExists(cache146)) return cache146;
  return null;
}

const chromePath = resolveChromePath();
if (!chromePath) {
  console.error('❌ Chrome lama helin.');
  console.error('   1) Rakib Google Chrome, ama');
  console.error('   2) cd whatsapp-bot');
  console.error('      node node_modules/whatsapp-web.js/node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome');
  process.exit(1);
}
console.log(`🌐 Chrome: ${chromePath}`);

const puppeteerOptions = {
  headless: process.env.BULK_HEADFUL !== '1',
  executablePath: chromePath,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
};
if (process.env.BULK_HEADFUL === '1') {
  console.log('🖥️ Chrome muuqda (BULK_HEADFUL=1) — xasilloon badan');
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: puppeteerOptions,
});

async function showQr(qr) {
  console.log('\n========================================');
  console.log('📱 SCAN QR — WhatsApp → Linked devices → Link a device');
  console.log('========================================\n');
  try {
    qrcodeTerminal.generate(qr, { small: true });
  } catch {
    console.log('(Terminal QR ma muuqan — fur scan-qr.html)');
  }

  const htmlPath = path.join(__dirname, 'scan-qr.html');
  const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Salama WhatsApp QR</title>
<style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#fff;margin:0}
img{background:#fff;padding:16px;border-radius:16px}p{max-width:360px;text-align:center;line-height:1.5}</style></head>
<body><h1>Salama — Scan QR</h1><p>WhatsApp phone → <b>Linked devices</b> → <b>Link a device</b></p>
<img src="${dataUrl}" alt="QR"/><p>Markaad scan-gareyso, terminal-ka wuxuu sii wadi doonaa fariimaha.</p></body></html>`;
  fs.writeFileSync(htmlPath, html);
  console.log(`\n🌐 QR browser: ${htmlPath}\n`);
  if (process.platform === 'win32') {
    exec(`start "" "${htmlPath}"`, (err) => {
      if (err) console.log('Fur gacanta: scan-qr.html');
    });
  }
}

client.on('loading_screen', (pct, msg) => {
  console.log(`⏳ WhatsApp loading: ${pct}% ${msg || ''}`);
});

client.on('authenticated', () => {
  console.log('✅ Session kaydsan — QR looma baahna');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  console.log('Tirtir .wwebjs_auth folder kadib mar kale isku day.');
});

client.on('qr', (qr) => {
  showQr(qr).catch((e) => console.error('QR display error:', e.message));
});

client.on('ready', async () => {
  console.log('✅ WhatsApp diyaar!');
  waReady = true;
  maybeStartSending();
});

function maybeStartSending() {
  if (!waReady || !prepDone || DRY_RUN || sendingStarted) return;
  sendAllMessages().catch((e) => {
    console.error('💥', e);
    shutdownClient().finally(() => process.exit(1));
  });
}

async function shutdownClient() {
  try {
    const browser = client.pupBrowser;
    if (browser) await browser.close();
  } catch (e) {
    console.warn('Browser close:', e.message);
  }
}

async function sendOneMessage(r) {
  const chatId = waChatId(r.waId);
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      await client.sendMessage(chatId, r.message);
      return { ok: true };
    } catch (err) {
      const msg = err.message || String(err);
      if (isRetryableWaError(msg) && attempt < MAX_SEND_RETRIES) {
        console.log(`   ⏳ Isku day ${attempt}/${MAX_SEND_RETRIES} — sug ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, error: msg };
    }
  }
  return { ok: false, error: 'Max retries' };
}

async function sendAllMessages() {
  if (sendingStarted) return;
  sendingStarted = true;

  const progress = loadProgress();
  let queue = recipientsToSend;
  if (RESUME && progress.sent.size > 0) {
    queue = queue.filter((r) => !progress.sent.has(r.display));
    console.log(`↩️ Resume: ${progress.sent.size} horey loo diray, ${queue.length} haray\n`);
  }

  console.log(`⏳ Sug ${WARMUP_MS / 1000}s — WhatsApp Web comms diyaar...`);
  await sleep(WARMUP_MS);

  console.log(`\n📤 Dirida ${queue.length} fariin... (Ctrl+C = jooji + kaydi progress)\n`);

  let ok = 0;
  let fail = 0;
  const sentSet = new Set(progress.sent);

  const onSigInt = () => {
    if (abortRequested) {
      console.log('\n🛑 Force quit.');
      process.exit(1);
    }
    abortRequested = true;
    console.log('\n⏸️ Joojin… dhammayn fariinta hadda socota, kadib waa la kaydinayaa.');
    saveProgress(sentSet, { aborted: true });
  };
  process.on('SIGINT', onSigInt);

  for (const r of queue) {
    if (abortRequested) {
      console.log('\n⏸️ La joojiyay adiga.');
      break;
    }
    if (sentSet.has(r.display)) {
      console.log(`⏭️ ${r.display} — horey loo diray`);
      continue;
    }

    console.log(`📤 ${r.display} (${r.kind === 'recovery42' ? '42-cusub' : 'raali'})...`);
    const result = await sendOneMessage(r);
    if (result.ok) {
      console.log('   ✅ La diray');
      ok++;
      sentSet.add(r.display);
      saveProgress(sentSet, { lastKind: r.kind });
    } else {
      console.error(`   ❌`, result.error);
      fail++;
    }
    await sleep(SEND_DELAY_MS);
  }

  saveProgress(sentSet, { done: !abortRequested });
  console.log('\n========================================');
  console.log(`✅ La diray (sesskan): ${ok}`);
  console.log(`❌ Fashilmay: ${fail}`);
  console.log(`📁 Progress: ${PROGRESS_PATH}`);
  if (abortRequested) {
    console.log('↩️ Sii wad: node bulk-send.js --send-only --apology-only --resume');
  }
  console.log('========================================\n');

  process.removeListener('SIGINT', onSigInt);
  await shutdownClient();
  process.exit(abortRequested ? 130 : fail > 0 ? 1 : 0);
}

(async () => {
  if (DRY_RUN) {
    const list = await prepareRecipients();
    console.log('\n🏁 Dry-run dhammaaday.');
    console.log(`🔗 Hubi link: ${APP_LINK}`);
    const sample = list.find((r) => r.kind === 'apology') || list[0];
    if (sample?.message) {
      console.log('\n--- Tusaale: raali galin (arday hore) ---\n');
      console.log(sample.message);
    }
    process.exit(0);
  }

  console.log('📱 Bilaabaya WhatsApp (QR wuxuu soo bixi doonaa haddii session cusub yahay)...\n');
  client.initialize();

  console.log('📋 Diyaarinta database + fariimaha (socda isku mar)...\n');
  recipientsToSend = await prepareRecipients();
  prepDone = true;
  console.log(`\n✅ ${recipientsToSend.length} fariin diyaar. Sug WhatsApp ready...\n`);
  maybeStartSending();

  setTimeout(() => {
    if (!waReady && prepDone) {
      console.log('\n⚠️ 60s timeout: WhatsApp weli ma diyaar.');
      console.log('   - Hubi Chrome / Puppeteer');
      console.log('   - Fur whatsapp-bot/scan-qr.html haddii la furay');
      console.log('   - Ama tirtir .wwebjs_auth kadib mar kale: node bulk-send.js\n');
    }
  }, 60000);
})().catch((e) => {
  console.error('💥', e);
  process.exit(1);
});
