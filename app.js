// app.js
// Node.js Express + Telegraf server that serves the UPI payment page and allows owner to update UPI/QR via Telegram bot.

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Telegraf } = require('telegraf');

const PORT = process.env.PORT || 3000;
const TELE_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '<YOUR_BOT_TOKEN>';
const OWNER_ID = process.env.OWNER_ID || '<OWNER_TELEGRAM_ID>'; // numeric string, e.g. "123456789"

// --- storage files ---
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const QR_PATH = path.join(PUBLIC_DIR, 'qr.png');

// ensure public dir exists
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// default data
let data = {
  upi: 'merchant@upi',
  payeeName: 'Merchant Name',
  upiValid: true   // whether upi is a valid VPA (controls whether buttons open apps)
};

// load data if exists
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    data = Object.assign(data, JSON.parse(raw));
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.warn('Could not read/write data.json', err);
}

// helper to persist
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ------------------------------
   Helper: UPI (VPA) basic validator
   Very simple regex: user can change to stricter rules if desired.
   Accepts patterns like username@bank or user.name@bank, allows -, . and _ in username.
   ------------------------------ */
function isValidUpi(vpa) {
  if (!vpa || typeof vpa !== 'string') return false;
  // trim
  const s = vpa.trim();
  // basic pattern
  const re = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
  return re.test(s);
}

/* ------------------------------
   Express server
   - Serves the payment page at "/"
   - Serves public assets (qr.png)
   - Ensures no caching for the page so changes show up quickly
   ------------------------------ */
const app = express();
app.use('/public', express.static(PUBLIC_DIR, { maxAge: 0 }));

// root page renders full HTML on every request using current data
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store'); // ensure always fresh
  const upiText = data.upi || 'merchant@upi';
  const payeeName = data.payeeName || 'Merchant Name';
  const upiValid = !!data.upiValid;
  // qr image: if q r file exists, use public/qr.png; otherwise fallback to a placeholder (data URI svg)
  const qrUrl = fs.existsSync(QR_PATH) ? '/public/qr.png' : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width=\"800\" height=\"800\"><rect width=\"100%\" height=\"100%\" fill=\"#f3f4f6\"/><text x=\"50%\" y=\"50%\" dominant-baseline=\"middle\" text-anchor=\"middle\" fill=\"#9ca3af\" font-size=\"20\">QR Not Available</text></svg>';

  // Serve the full HTML page (this is your existing UI code, with a few small runtime inserts)
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pay Here — UPI Payment</title>
  <style>
    :root{
      --page-bg:#eef6fb;
      --panel:#ffffff;
      --muted:#6b7280;
      --accent:#0b61ff;
      --radius:12px;
      --shadow:0 10px 30px rgba(12,20,40,0.06);
      --light-gray:#f3f4f6;
      --copy-gray:#eef2f6;
    }
    html,body{height:100%;margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial;background:var(--page-bg);color:#0f1724}

    /* container */
    .page{max-width:760px;margin:18px auto;padding:0 12px}
    .card{background:linear-gradient(180deg,#f8fcff,#ffffff);border-radius:16px;padding:14px;box-shadow:var(--shadow);overflow:hidden}

    /* topbar */
    .topbar{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:linear-gradient(90deg,#e6f5ff,#dff2ff)}
    .logo{width:48px;height:48px;border-radius:10px;background:linear-gradient(135deg,#0b61ff,#33a1ff);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px}
    .title{font-size:26px;font-style:italic;color:#08324a;font-weight:800;letter-spacing:0.3px}

    /* QR area */
    .qr-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px}
    .qr-frame{width:320px;height:320px;border-radius:12px;border:1px dashed rgba(8,12,20,0.06);overflow:hidden;background:#fff;display:grid;place-items:center}
    .qr-frame img{width:100%;height:100%;object-fit:cover;display:block}
    .controls{display:flex;gap:10px;align-items:center;width:92%}
    .download{flex:1;padding:12px;border-radius:18px;background:linear-gradient(90deg,#dff7e1,#c6f0c9);border:1px solid rgba(10,91,46,0.08);font-weight:700;cursor:pointer}

    /* UPI single thin box with copy inside */
    .upi-box{margin-top:10px;display:flex;align-items:center;gap:8px;width:92%}
    .upi-pill{flex:1;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:#fafcff;border:1px solid rgba(8,12,20,0.06);font-weight:700}
    .upi-text{font-size:15px;color:#0b1f2f}
    .copy-btn{padding:6px 10px;border-radius:8px;background:var(--copy-gray);color:#425066;border:0;cursor:pointer;font-weight:700}

    /* apps */
    .apps{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
    .app-btn{padding:12px;border-radius:10px;border:0;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center}
    .paytm{background:linear-gradient(90deg,#e6f0ff,#cfe6ff);color:#003366}
    .gpay{background:linear-gradient(90deg,#fff,#fff7ed);color:#111;border:1px solid rgba(0,0,0,0.06)}
    .phonepe{background:linear-gradient(90deg,#f3e9ff,#efe2ff);color:#3a0b66}
    .other{background:linear-gradient(90deg,#dcd6ff,#cfc6ff);color:#221f3a}

    /* carousel + static header */
    .carousel-wrap{margin-top:12px}
    .carousel-header{
      padding:8px;
      border-radius:8px;
      background:linear-gradient(180deg,#f5f7fa,#ffffff);
      border:1px solid rgba(8,12,20,0.04);
      color:#475569;
      font-weight:700;
      font-size:14px;
    }
    .carousel{
      margin-top:8px;
      overflow:hidden;
      border-radius:8px;
      height:340px;
    }
    .slides{
      display:flex;
      transition:transform 0.6s ease;
      gap:0;
    }
    .slide{
      min-width:100%;
      flex-shrink:0;
      padding:0;
      height:100%;
      display:flex;
      justify-content:center;
      align-items:center;
    }
    .slide img{
      width:100%;
      height:340px;
      object-fit:contain;
      border-radius:8px;
    }

    /* instructions in light shiny box (smaller text) */
    .instructions-box{margin-top:12px;padding:10px;border-radius:10px;background:linear-gradient(180deg,#f8fbff,#ffffff);border:1px solid rgba(8,12,20,0.04);box-shadow:0 6px 18px rgba(11,97,255,0.03)}
    .how-title{font-weight:800;color:#111;margin-bottom:8px}
    .how-list{display:flex;flex-direction:column;gap:6px}
    .how-item{background:transparent;padding:6px;color:#475569;font-size:13px}

    /* contact */
    .contact-row{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:14px}
    .contact-btn{padding:12px 18px;border-radius:8px;background:#f3f4f6;color:#111;border:0;font-weight:800;cursor:pointer}
    .contact-small{font-size:13px;color:var(--muted);text-align:center}

    @media (max-width:480px){
      .qr-frame{width:260px;height:260px}
      .title{font-size:22px}
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <div class="topbar">
        <div class="logo">Pay</div>
        <div class="title">Pay Here</div>
      </div>

      <div class="qr-wrap">
        <div class="qr-frame" id="qrframe"><img id="qrimg" src="${qrUrl}" alt="QR image"></div>
        <div class="controls">
          <button id="downloadBtn" class="download">Download QR Code</button>
        </div>
      </div>

      <div class="upi-box">
        <div class="upi-pill">
          <div class="upi-text" id="upiField">${upiText}</div>
          <button id="copyUpi" class="copy-btn">Copy</button>
        </div>
      </div>

      <div class="apps">
        <button id="btnPaytm" class="app-btn paytm">PAYTM</button>
        <button id="btnGpay" class="app-btn gpay">G PAY</button>
        <button id="btnPhonePe" class="app-btn phonepe">Phone पे</button>
        <button id="btnOther" class="app-btn other">Other UPI Apps</button>
      </div>

      <div class="carousel-wrap">
        <div class="carousel-header">📲  How to send payment Screenshot</div>
        <div class="carousel"><div class="slides" id="slides"></div></div>
      </div>

      <div class="instructions-box">
        <div class="how-title">Instruction ❗</div>
        <div class="how-list" id="howList"></div>
      </div>

      <div class="contact-row">
        <button id="contactBtn" class="contact-btn">💬 Contact Admin</button>
        <div class="contact-small" id="contactSmall">Send Screenshot to Admin</div>
      </div>

    </div>
  </div>

<script>
  // client-side values from server
  const SERVER_UPI = ${JSON.stringify(upiText)};
  const SERVER_PAYEE = ${JSON.stringify(payeeName)};
  const SERVER_UPI_VALID = ${upiValid ? 'true' : 'false'};

  const ADMIN_CAROUSEL = ${JSON.stringify(data.carousel || [])};
  const ADMIN_INSTRUCTIONS = ${JSON.stringify(data.instructions || [])};

  // populate carousel with the server-provided images
  const slidesEl = document.getElementById('slides');
  (ADMIN_CAROUSEL || []).forEach(url => {
    const s = document.createElement('div'); s.className = 'slide';
    const img = document.createElement('img'); img.src = url; img.alt = 'step';
    s.appendChild(img); slidesEl.appendChild(s);
  });

  // carousel autoplay (basic)
  let cIndex = 0;
  function showSlide(i){ slidesEl.style.transform = `translateX(-${i*100}%)`; }
  setInterval(()=>{ cIndex = (cIndex+1) % (ADMIN_CAROUSEL.length || 1); showSlide(cIndex); }, 2200);

  // populate instructions
  const howList = document.getElementById('howList');
  (ADMIN_INSTRUCTIONS || []).forEach(line => {
    const d = document.createElement('div'); d.className = 'how-item'; d.textContent = line; howList.appendChild(d);
  });

  // QR download
  const qrImg = document.getElementById('qrimg');
  async function downloadQr(){
    try{
      const res = await fetch(qrImg.src, { mode:'cors' });
      if(!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'upi-qr.png';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showToast('QR downloaded to device');
    }catch(e){
      console.warn(e);
      window.open(qrImg.src, '_blank');
      showToast('Could not download directly — opened image to save manually');
    }
  }
  document.getElementById('downloadBtn').addEventListener('click', downloadQr);

  // copy UPI
  document.getElementById('copyUpi').addEventListener('click', async ()=>{
    try{ await navigator.clipboard.writeText(SERVER_UPI); showToast('UPI copied'); }
    catch(e){ const t=document.createElement('textarea'); t.value = SERVER_UPI; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); showToast('UPI copied'); }
  });

  // app openers - if upi valid then open, else show alert
  const PACK = { gpay:'com.google.android.apps.nbu.paisa.user', phonepe:'com.phonepe.app', paytm:'net.one97.paytm' };
  function buildQuery(){
    const params = new URLSearchParams({ pa: SERVER_UPI, pn: SERVER_PAYEE, cu: 'INR' });
    return params.toString();
  }
  function openChain(pref){
    if(!SERVER_UPI_VALID){ alert('UPI not configured. Contact admin.'); return; }
    const query = buildQuery();
    const generic = 'upi://pay?' + query;
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    if(isAndroid){
      let i=0;
      function next(){ if(i>=pref.length){ window.location.href = generic; return; } const key=pref[i++]; const pkg=PACK[key]; if(!pkg){ next(); return;} const intent = `intent://pay?${query}#Intent;scheme=upi;package=${pkg};end`; window.location.href = intent; setTimeout(next,1200); }
      next();
    } else if(isIOS){ window.location.href = generic; } else { alert('Open this page on mobile to pay'); }
  }
  document.getElementById('btnPaytm').addEventListener('click', ()=>openChain(['paytm','phonepe','gpay']));
  document.getElementById('btnGpay').addEventListener('click', ()=>openChain(['gpay','phonepe','paytm']));
  document.getElementById('btnPhonePe').addEventListener('click', ()=>openChain(['phonepe','paytm','gpay']));
  document.getElementById('btnOther').addEventListener('click', ()=>{ if(!SERVER_UPI_VALID){ alert('UPI not configured. Contact admin.'); return; } window.location.href = 'upi://pay?pa='+encodeURIComponent(SERVER_UPI)+'&pn='+encodeURIComponent(SERVER_PAYEE)+'&cu=INR'; });

  // toast helper
  function showToast(msg){ const t=document.createElement('div'); t.textContent=msg; t.style.position='fixed'; t.style.left='50%'; t.style.bottom='22px'; t.style.transform='translateX(-50%)'; t.style.background='rgba(11,97,255,0.95)'; t.style.color='#fff'; t.style.padding='8px 12px'; t.style.borderRadius='8px'; t.style.zIndex=9999; document.body.appendChild(t); setTimeout(()=>t.style.opacity='0.01',1500); setTimeout(()=>t.remove(),2000); }

</script>
</body>
</html>`);
});

/* ------------------------------
   Telegram bot (Telegraf)
   - supports only owner (OWNER_ID)
   - /set_qr : asks for image; owner sends photo or 'NOT AVAILABLE'
   - /set_upi: asks for UPI text; owner sends text
   ------------------------------ */

if (!TELE_TOKEN || TELE_TOKEN.includes('<YOUR_BOT_TOKEN>')) {
  console.error('Missing TELEGRAM_BOT_TOKEN env var. Set TELEGRAM_BOT_TOKEN and OWNER_ID.');
  console.error('Server will still run but bot will be disabled.');
}

// map of owner states: 'idle' | 'awaiting_qr' | 'awaiting_upi'
const ownerState = { state: 'idle' };

let bot;
if (TELE_TOKEN && !TELE_TOKEN.includes('<YOUR_BOT_TOKEN>')) {
  bot = new Telegraf(TELE_TOKEN);

  // helper: only owner middleware
  bot.use(async (ctx, next) => {
    const from = ctx.from && ctx.from.id ? String(ctx.from.id) : '';
    if (String(OWNER_ID) !== from) {
      // ignore non-owner commands - do not reply to everyone
      // but if you'd like you can send a short "not authorized" reply
      // ctx.reply('Not authorized.');
      return;
    }
    return next();
  });

  bot.command('set_qr', async (ctx) => {
    ownerState.state = 'awaiting_qr';
    await ctx.reply('Send the QR image (photo) to set it on the site. Or send the text NOT AVAILABLE to show a placeholder.');
  });

  bot.command('set_upi', async (ctx) => {
    ownerState.state = 'awaiting_upi';
    await ctx.reply('Send the UPI ID (example: merchant@bank). If you send invalid text, it will still be displayed but app buttons will be disabled.');
  });

  // handle photos (owner)
  bot.on('photo', async (ctx) => {
    const from = ctx.from && ctx.from.id ? String(ctx.from.id) : '';
    if (String(OWNER_ID) !== from) return;
    if (ownerState.state !== 'awaiting_qr') {
      return ctx.reply('I was not expecting a photo right now. Use /set_qr to start.');
    }
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const fileLink = await ctx.telegram.getFileLink(largest.file_id);
      // download and save to public/qr.png
      const resp = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      fs.writeFileSync(QR_PATH, resp.data);
      ownerState.state = 'idle';
      ctx.reply('QR updated and saved. Web page will now show the new QR.');
    } catch (err) {
      console.error('Failed to save QR:', err);
      ctx.reply('Failed to download/save the image. Try again.');
    }
  });

  // handle text messages (owner)
  bot.on('text', async (ctx) => {
    const from = ctx.from && ctx.from.id ? String(ctx.from.id) : '';
    if (String(OWNER_ID) !== from) return;

    const txt = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';

    if (ownerState.state === 'awaiting_qr') {
      if (txt.toLowerCase() === 'not available' || txt.toLowerCase() === 'not_available' || txt.toLowerCase() === 'na') {
        // remove qr file if exists (so site shows placeholder)
        try { if (fs.existsSync(QR_PATH)) fs.unlinkSync(QR_PATH); } catch(e){ /* ignore */ }
        ownerState.state = 'idle';
        ctx.reply('QR set to NOT AVAILABLE — web page will show placeholder.');
      } else {
        ctx.reply('Please send the QR as an image (photo). If you want to remove the QR, send: NOT AVAILABLE');
      }
      return;
    }

    if (ownerState.state === 'awaiting_upi') {
      // set upi (even if invalid, we store and mark validity)
      const newUpi = txt;
      const valid = isValidUpi(newUpi);
      data.upi = newUpi;
      data.upiValid = !!valid;
      saveData();
      ownerState.state = 'idle';
      if (valid) {
        await ctx.reply(`UPI updated to: ${newUpi} (valid). Web page will use this UPI for payments.`);
      } else {
        await ctx.reply(`UPI updated to: ${newUpi} (marked INVALID). Buttons will be disabled until a valid UPI is set.`);
      }
      return;
    }

    // not currently awaiting anything
    // you can reply to other owner messages if you want
  });

  bot.launch().then(()=> console.log('Telegram bot started (polling)')).catch(err => console.error('Bot failed to start', err));

  // graceful shutdown for Heroku
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  console.log('Bot disabled because TELEGRAM_BOT_TOKEN not provided.');
}

/* start server */
app.listen(PORT, () => {
  console.log('Server listening on port', PORT);
  console.log('Open http://localhost:' + PORT + ' or set your Heroku URL');
});
