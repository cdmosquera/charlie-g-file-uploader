try { process.loadEnvFile(); } catch {}

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const google = require('./lib/google');

const PORT = Number(process.env.PORT) || 3000;
process.env.BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD']) {
  if (!process.env[key]) console.warn(`[warn] ${key} is not set — see .env.example`);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- helpers ----------

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }),
  );
}

function setCookie(res, name, value, maxAgeSec) {
  const secure = process.env.BASE_URL.startsWith('https') ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function isAdmin(req) {
  const [exp, sig] = (cookies(req).admin || '').split('.');
  return exp && sig && Number(exp) > Date.now() && safeEqual(sig, sign(`admin.${exp}`));
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return safeEqual(crypto.scryptSync(String(pw || ''), salt, 32).toString('hex'), hash);
}

const cleanName = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\\/]/g, ' ').trim().slice(0, max);

function linkState(link) {
  if (!link.active) return 'disabled';
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) return 'expired';
  return 'open';
}

function publicLink(link) {
  return {
    title: link.title,
    description: link.description,
    needsPassword: !!link.passwordHash,
    maxSizeMB: link.maxSizeMB,
    allowedTypes: link.allowedTypes,
    askName: link.askName,
    askEmail: link.askEmail,
    requireName: link.requireName,
    state: linkState(link),
  };
}

// Simple per-IP limiter for upload session creation.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 200) return res.status(429).json({ error: 'Too many uploads, try again later' });
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

// ---------- pages ----------

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/u/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));

// ---------- admin auth ----------

app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || !safeEqual(req.body.password || '', process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  setCookie(res, 'admin', `${exp}.${sign(`admin.${exp}`)}`, 7 * 24 * 3600);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(res, 'admin', '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/status', (req, res) => {
  const g = store.get().google;
  res.json({
    loggedIn: isAdmin(req),
    connected: isAdmin(req) ? !!g?.refreshToken : undefined,
    email: isAdmin(req) ? g?.email : undefined,
    baseUrl: process.env.BASE_URL,
  });
});

// ---------- Google connection ----------

app.get('/auth/google', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 600);
  res.redirect(google.authUrl(state));
});

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  if (req.query.error) return res.redirect(`/admin?error=${encodeURIComponent(req.query.error)}`);
  if (!req.query.state || !safeEqual(req.query.state, cookies(req).oauth_state || '')) {
    return res.status(400).send('Invalid OAuth state, please try connecting again.');
  }
  const tokens = await google.exchangeCode(req.query.code);
  const db = store.get();
  const refreshToken = tokens.refresh_token || db.google?.refreshToken;
  if (!refreshToken) return res.status(400).send('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
  db.google = { refreshToken, email: null };
  store.save();
  db.google.email = await google.getUserEmail();
  store.save();
  setCookie(res, 'oauth_state', '', 0);
  res.redirect('/admin');
}));

app.post('/api/admin/disconnect', requireAdmin, (req, res) => {
  store.get().google = null;
  google.resetToken();
  store.save();
  res.json({ ok: true });
});

// ---------- admin: links ----------

app.get('/api/admin/links', requireAdmin, (req, res) => {
  const db = store.get();
  res.json(db.links.map((l) => ({
    ...l,
    passwordHash: undefined,
    hasPassword: !!l.passwordHash,
    state: linkState(l),
    url: `${process.env.BASE_URL}/u/${l.slug}`,
    uploadCount: db.uploads.filter((u) => u.linkId === l.id).length,
  })).reverse());
});

app.post('/api/admin/links', requireAdmin, asyncRoute(async (req, res) => {
  const db = store.get();
  if (!db.google?.refreshToken) return res.status(400).json({ error: 'Connect Google Drive first' });
  const b = req.body;
  const title = cleanName(b.title, 120);
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const folder = await google.createFolder(cleanName(b.folderName, 120) || title);
  const link = {
    id: crypto.randomUUID(),
    slug: crypto.randomBytes(6).toString('base64url'),
    title,
    description: String(b.description || '').slice(0, 2000),
    folderId: folder.id,
    folderUrl: folder.webViewLink,
    passwordHash: b.password ? hashPassword(String(b.password)) : null,
    maxSizeMB: Math.max(0, Number(b.maxSizeMB) || 0),
    allowedTypes: String(b.allowedTypes || '')
      .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      .map((t) => (t.startsWith('.') ? t : `.${t}`)),
    expiresAt: b.expiresAt ? new Date(b.expiresAt).toISOString() : null,
    askName: !!b.askName,
    requireName: !!b.askName && !!b.requireName,
    askEmail: !!b.askEmail,
    perUploaderFolder: !!b.askName && !!b.perUploaderFolder,
    subfolders: {},
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.links.push(link);
  store.save();
  res.json({ ok: true, id: link.id });
}));

app.patch('/api/admin/links/:id', requireAdmin, (req, res) => {
  const link = store.get().links.find((l) => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  if ('active' in req.body) link.active = !!req.body.active;
  store.save();
  res.json({ ok: true });
});

app.delete('/api/admin/links/:id', requireAdmin, (req, res) => {
  const db = store.get();
  db.links = db.links.filter((l) => l.id !== req.params.id);
  store.save();
  res.json({ ok: true }); // the Drive folder and its files are kept
});

app.get('/api/admin/links/:id/uploads', requireAdmin, (req, res) => {
  res.json(store.get().uploads.filter((u) => u.linkId === req.params.id).reverse());
});

// ---------- public upload API ----------

function findOpenLink(req, res) {
  const link = store.get().links.find((l) => l.slug === req.params.slug);
  if (!link) { res.status(404).json({ error: 'This upload link does not exist' }); return null; }
  const state = linkState(link);
  if (state !== 'open') { res.status(410).json({ error: `This upload link is ${state}` }); return null; }
  return link;
}

app.get('/api/links/:slug', (req, res) => {
  const link = store.get().links.find((l) => l.slug === req.params.slug);
  if (!link) return res.status(404).json({ error: 'This upload link does not exist' });
  res.json(publicLink(link));
});

app.post('/api/links/:slug/unlock', (req, res) => {
  const link = findOpenLink(req, res);
  if (!link) return;
  if (link.passwordHash && !checkPassword(req.body.password, link.passwordHash)) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  res.json({ ok: true });
});

const pending = new Map(); // upload id -> details, until the browser confirms completion
const folderLocks = new Map();

async function uploaderFolder(link, uploader) {
  const name = cleanName(uploader, 100);
  if (link.subfolders[name]) return link.subfolders[name];
  const key = `${link.id}:${name}`;
  if (!folderLocks.has(key)) {
    folderLocks.set(key, (async () => {
      const existing = await google.findFolder(name, link.folderId);
      const id = existing ? existing.id : (await google.createFolder(name, link.folderId)).id;
      link.subfolders[name] = id;
      store.save();
      return id;
    })().finally(() => folderLocks.delete(key)));
  }
  return folderLocks.get(key);
}

app.post('/api/links/:slug/session', rateLimit, asyncRoute(async (req, res) => {
  const link = findOpenLink(req, res);
  if (!link) return;
  const { password, name, email, file } = req.body;

  if (link.passwordHash && !checkPassword(password, link.passwordHash)) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  const uploader = link.askName ? cleanName(name, 100) : '';
  if (link.requireName && !uploader) return res.status(400).json({ error: 'Please enter your name' });

  const fileName = cleanName(file?.name);
  const size = Number(file?.size);
  if (!fileName || !Number.isFinite(size) || size < 0) return res.status(400).json({ error: 'Invalid file' });
  if (link.maxSizeMB && size > link.maxSizeMB * 1024 * 1024) {
    return res.status(400).json({ error: `File is larger than ${link.maxSizeMB} MB` });
  }
  const ext = path.extname(fileName).toLowerCase();
  if (link.allowedTypes.length && !link.allowedTypes.includes(ext)) {
    return res.status(400).json({ error: `Only ${link.allowedTypes.join(', ')} files are allowed` });
  }

  const parentId = link.perUploaderFolder && uploader ? await uploaderFolder(link, uploader) : link.folderId;
  const uploaderEmail = link.askEmail ? cleanName(email, 200) : '';
  const descr = [uploader && `Uploaded by ${uploader}`, uploaderEmail && `<${uploaderEmail}>`, `via "${link.title}"`]
    .filter(Boolean).join(' ');

  const uploadUrl = await google.createUploadSession({
    name: fileName,
    mimeType: String(file.type || 'application/octet-stream'),
    size,
    parentId,
    description: descr,
    origin: req.get('origin') || process.env.BASE_URL,
  });

  const id = crypto.randomUUID();
  pending.set(id, { linkId: link.id, parentId, fileName, size, uploader, uploaderEmail, ip: req.ip, created: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.created > 24 * 3600 * 1000) pending.delete(k);

  res.json({ uploadUrl, uploadId: id });
}));

app.post('/api/links/:slug/complete', asyncRoute(async (req, res) => {
  const p = pending.get(req.body.uploadId);
  if (!p) return res.status(400).json({ error: 'Unknown upload' });
  const file = await google.getFile(String(req.body.fileId || ''));
  if (!file.parents?.includes(p.parentId)) return res.status(400).json({ error: 'File mismatch' });
  pending.delete(req.body.uploadId);

  store.get().uploads.push({
    linkId: p.linkId,
    fileId: file.id,
    fileName: file.name,
    size: Number(file.size ?? p.size),
    uploader: p.uploader,
    uploaderEmail: p.uploaderEmail,
    ip: p.ip,
    url: file.webViewLink,
    at: new Date().toISOString(),
  });
  store.save();
  res.json({ ok: true });
}));

app.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Drive Drop running at ${process.env.BASE_URL} (admin: ${process.env.BASE_URL}/admin)`));
