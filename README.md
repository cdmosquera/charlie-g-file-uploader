# Drive Drop

A self-hosted alternative to DriveUploader: create upload links, share them with anyone, and the files land in **your** Google Drive. Uploaders don't need a Google account.

## How it works

1. You log in to `/admin` and connect your Google account once. The app stores a refresh token for your Drive.
2. You create an upload link. The app creates a matching folder in your Drive.
3. Anyone with the link (`/u/<id>`) can drag and drop files. The browser sends each file **directly to Google Drive** through a resumable upload session the server opens with your account. Big files never pass through your server, so cheap hosting works fine.

Per-link options: password, max file size, allowed file types, expiry date, ask for name/email, one subfolder per uploader, enable/disable. The dashboard shows an upload log for each link.

The app uses the `drive.file` scope, so it can only see the folders and files it created itself, not the rest of your Drive.

## 1. Google Cloud setup (one time, ~5 minutes)

1. Go to https://console.cloud.google.com/ and create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**. Fill in app name and your email.
   - Scopes: add `.../auth/drive.file`.
   - **Audience → Publish app** (set it to *In production*). In *Testing* mode Google expires refresh tokens after 7 days, and your links would stop working. `drive.file` is not a restricted scope, so you can publish without a security review. You may see an "unverified app" warning when you connect your own account; click *Advanced → Continue*.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback` (add your production URL too, e.g. `https://upload.example.com/auth/google/callback`)
5. Copy the Client ID and Client secret.

## 2. Run locally

Requires Node.js 20.12 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`, then:

```bash
npm start
```

Open http://localhost:3000/admin, log in, click **Connect Google Drive**, and create your first link.

## 3. Deploy so others can use the links

Any Node host works (Render, Railway, Fly.io, a VPS…). Things to set:

- Environment variables from `.env.example`, with `BASE_URL` set to your public https URL.
- The same `<BASE_URL>/auth/google/callback` added as a redirect URI in Google Cloud.
- A **persistent disk** mounted at `DATA_DIR`. `data/db.json` holds your links, the upload log and the Drive refresh token, so keep it private and backed up.

## Notes and limits

- Files count against your Drive storage quota. Google caps uploads at 750 GB per account per day.
- If an upload is interrupted, the uploader has to retry that file (it restarts from zero).
- Deleting a link in the dashboard keeps its Drive folder and files.
- Upload sessions are rate limited to 200 per IP per 10 minutes.
