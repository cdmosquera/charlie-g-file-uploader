// Minimal Google OAuth + Drive v3 client using the owner's stored refresh token.
// Scope is drive.file: the app can only see folders/files it created itself,
// which is all it needs and avoids Google's restricted-scope verification.
const store = require('./store');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const redirectUri = () => `${process.env.BASE_URL}/auth/google/callback`;

let cached = { token: null, expires: 0 };

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error}`);
  return data;
}

async function exchangeCode(code) {
  const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data;
}

async function accessToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const g = store.get().google;
  if (!g?.refreshToken) throw new Error('Google Drive is not connected');
  const data = await tokenRequest({ refresh_token: g.refreshToken, grant_type: 'refresh_token' });
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

function resetToken() {
  cached = { token: null, expires: 0 };
}

async function api(method, url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API ${res.status}: ${text}`);
  }
  return res;
}

async function getUserEmail() {
  const res = await api('GET', `${DRIVE}/about?fields=user(emailAddress)`);
  return (await res.json()).user.emailAddress;
}

async function createFolder(name, parentId) {
  const res = await api('POST', `${DRIVE}/files?fields=id,name,webViewLink`, {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  });
  return res.json();
}

async function findFolder(name, parentId) {
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${esc}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await api('GET', `${DRIVE}/files?fields=files(id)&q=${encodeURIComponent(q)}`);
  return (await res.json()).files[0] || null;
}

// Starts a resumable upload session. The browser then PUTs the file bytes
// straight to the returned URL, so large files never pass through this server.
// Passing the browser's Origin makes Google allow the cross-origin PUT.
async function createUploadSession({ name, mimeType, size, parentId, description, origin }) {
  const res = await api(
    'POST',
    `${UPLOAD}/files?uploadType=resumable&fields=id,name,size`,
    { name, parents: [parentId], description },
    {
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size),
      ...(origin ? { Origin: origin } : {}),
    },
  );
  return res.headers.get('location');
}

async function getFile(id) {
  const res = await api('GET', `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,size,parents,webViewLink`);
  return res.json();
}

module.exports = {
  authUrl,
  exchangeCode,
  resetToken,
  getUserEmail,
  createFolder,
  findFolder,
  createUploadSession,
  getFile,
};
