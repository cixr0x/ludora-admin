# Ludora TikTok Curator Extension

This unpacked Chrome extension adds a small Ludora curation panel on TikTok pages.

## Local Use

1. Start the admin service from `ludora-admin/ludora-admin-service`:

   ```powershell
   npm run dev:codex
   ```

2. Start the admin UI from `ludora-admin/ludora-admin-ui`:

   ```powershell
   npm run dev:codex
   ```

3. Open `http://127.0.0.1:5173/` in Chrome and sign in. The extension reuses this admin session and never
   stores the admin password.
4. Open Chrome extensions: `chrome://extensions`.
5. Enable Developer mode.
6. Click **Load unpacked** and select this folder, or click **Reload** if it is already installed:

   ```text
   C:\PROJECTS\ludora\ludora-admin\chrome-extension\tiktok-curator
   ```

7. Open or reload `https://www.tiktok.com/`.
8. In the Ludora TikTok panel:
   - Click **Load next** to fetch the next item without a TikTok candidate.
   - Click **Search** to open the TikTok search query for that item.
   - Open the best video result.
   - Click **Save current video** to store it as a `candidate` tutorial link.
   - Click **Skip item** when no suitable video exists. Skipped items are remembered locally by Chrome and excluded from later **Load next** requests.

The extension calls the admin service. The admin service owns database writes.
