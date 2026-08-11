# Practical CodexAPI Security Design

## Goal

Ship the AI-assisted BGG matcher with a CodexAPI boundary appropriate for a small board-game platform: protect against untrusted product text and image URLs without building a custom deployment operating system.

## Scope decision

The selected approach is **hardened runtime plus standard Linux service management**.

- Keep the BGG matcher and cache fixes through Ludora commit `b37705a`.
- Keep the functional CodexAPI hardening through CodexAPI commit `f81de99`.
- Do not ship or continue the custom immutable deployment controller from Ludora commits after `b37705a`.
- Preserve that experiment on `archive/immutable-codexapi-deploy-20260810` for future reference.

Rejected alternatives:

1. **Continue the custom controller.** Rejected because bespoke filesystem, identity, systemd, transaction, recovery, rollback, and bootstrap machinery is disproportionate to this platform.
2. **Run the old full-access service unchanged.** Rejected because untrusted store text and images could reach a general-purpose Codex process with host access.

## Realistic threat model

Defend against:

- prompt injection in product names or covers;
- SSRF and unsafe remote image downloads;
- inherited shell, MCP, browser, image-view, plugin, or local-workspace capabilities;
- credential exposure through the service identity;
- malformed or unexpected Codex output events;
- unbounded request time, image size, output, or retry behavior;
- accidental public exposure of port `3001`.

Rely on standard operating-system and deployment controls for:

- trusted root and deployment administrators;
- normal filesystem ownership and systemd isolation;
- deliberate, operator-driven deployment and rollback;
- VM backup and disaster recovery.

The system does not attempt to survive a malicious root administrator, adversarial inode replacement after every check, or a crash after every individual filesystem mutation.

## Runtime boundary

CodexAPI remains loopback-only at `127.0.0.1:3001` and uses:

- the pinned package-local Codex CLI;
- startup attestation of CLI version, disabled features, and empty MCP inventory;
- a sanitized child environment and dedicated empty workspace;
- no inherited shell, plugins, apps, computer control, local image viewing, or arbitrary MCP servers;
- strict request and JSONL event parsing;
- safe bounded remote-image validation and temporary-file cleanup;
- one SDK request with retries disabled.

The Ludora admin service sends the BGG matcher only the product name and optional image URL. Missing images remain valid name-only matching requests.

## Production boundary

Use a normal dedicated `codexapi` system account with:

- home and `CODEX_HOME` under `/var/lib/codexapi`;
- an empty `/var/lib/codexapi/workspace`;
- no access to the Ludora admin checkout or the deployment user's home;
- a checked-in hardened systemd unit;
- loopback-only host and fixed port;
- only `/var/lib/codexapi` and the private temporary directory writable.

Routine deployment remains a short operator-run procedure:

1. require an explicit approved commit and clean checkout;
2. stop CodexAPI before replacing dependencies or build artifacts;
3. fast-forward to the approved commit;
4. run `npm ci`, tests, and build;
5. start the service and verify startup attestation plus loopback health;
6. on failure, keep the service stopped and explicitly rebuild the previous known commit before restarting it.

No custom journal, filesystem abstraction, release manifest, symlink transaction, systemd parser, identity provisioner, or automatic bootstrap controller is added.

## Repository split

### Ludora

Base the practical branch at `b37705a`. Update only the production runbook and agent guidance needed to reference the checked-in CodexAPI unit and concise deployment/rollback procedure.

### CodexAPI

Base the practical branch at `f81de99`. Keep runtime code, tests, README, `.env.example`, and the pinned package. Remove internal Superpowers design/report artifacts from the shipping branch, simplify migration-only AGENTS guidance, and add the checked-in systemd unit plus a static contract test.

## Verification

- Run the complete CodexAPI test suite, typecheck, and build.
- Run focused Ludora BGG matcher/cache tests plus admin-service build.
- Run discovery matcher tests that cover the admin endpoint contract.
- Statically verify the systemd unit is loopback-only, uses the dedicated identity, hides Ludora/admin homes, and grants no broad write path.
- Verify the runbook contains no custom immutable-controller commands or inline bespoke deployment program.
- Do not deploy, push, authenticate, run services, or execute SQL as part of implementation.
