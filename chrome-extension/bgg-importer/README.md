# Import to Ludoradar

This unpacked Chrome extension imports an item into Ludora from a BoardGameGeek or RPGGeek item page. It uses the production Ludora Admin session in your Chrome profile.

## Install and use

1. In Chrome, sign in to [Ludora Admin](https://admin.ludora.bobbycrimson.com/).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `chrome-extension/bgg-importer` folder, which contains `manifest.json`.
4. Open an item page or reload one that was already open. On BoardGameGeek the button supports `boardgame`, `boardgameexpansion`, `boardgameaccessory`, `rpgitem`, game editions at `/boardgameversion/<id>`, and accessory editions at `/bgaccessoryversion/<id>`. On RPGGeek it supports `rpgitem`.
5. Click **Import to Ludoradar**. The extension calls the existing Admin import action, then generates and saves a Spanish description if the item does not already have one. Generation uses the imported description and the first available linked store description.

On edition pages, the extension includes the edition nickname when it is visible. Admin uses the XML nickname first and falls back to the nickname from the open BGG edition page. A newly imported catalog title includes a distinct nickname in parentheses. For an edition whose XML nickname is blank, use **Open edition on BGG** in the Admin picker and import it from the extension to save the page nickname on the first import. Repeat imports keep the existing catalog title.

If the extension asks you to sign in, use its Admin link and return to the item to retry. If it reports a missing source, open the imported item in Admin and add a source description before retrying. **Retry import** runs the import again. Admin normally reuses a recently imported item, and the extension skips description generation once Spanish text exists.

The existing Admin API saves a full item record. An edit saved in Admin after the extension's final read can be overwritten by the extension's save.

After updating the extension files, click **Reload** on its card in `chrome://extensions` and refresh any Geek tabs already open.

## Tests

From the repository root, run the worker and content-script tests. They use simulated extension events and API responses.

```powershell
node --test chrome-extension/bgg-importer/*.test.mjs
```
