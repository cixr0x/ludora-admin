# Ludora TikTok Curator Extension

This unpacked Chrome extension adds a small Ludora curation panel on TikTok pages.

## Local Use

1. Start the admin service from `ludora-admin/ludora-admin-service`:

   ```powershell
   npm run dev:codex
   ```

2. Open Chrome extensions: `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked** and select this folder:

   ```text
   C:\PROJECTS\ludora\ludora-admin\chrome-extension\tiktok-curator
   ```

5. Open `https://www.tiktok.com/`.
6. In the Ludora TikTok panel:
   - Click **Load next** to fetch the next item without a TikTok candidate.
   - Click **Search** to open the TikTok search query for that item.
   - Open the best video result.
   - Click **Save current video** to store it as a `candidate` tutorial link.
   - Click **Skip item** when no suitable video exists. Skipped items are remembered locally by Chrome and excluded from later **Load next** requests.

The extension calls the admin service. The admin service owns database writes.
