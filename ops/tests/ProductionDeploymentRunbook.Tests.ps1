$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runbook = Get-Content -Raw (Join-Path $repoRoot 'docs/production-deployment.md')
$agents = Get-Content -Raw (Join-Path $repoRoot 'AGENTS.md')

function Get-RunbookSection {
    param(
        [Parameter(Mandatory = $true)][string]$StartHeading,
        [Parameter(Mandatory = $true)][string]$EndHeading
    )

    $start = $runbook.IndexOf($StartHeading, [StringComparison]::Ordinal)
    $end = $runbook.IndexOf($EndHeading, $start + $StartHeading.Length, [StringComparison]::Ordinal)
    if ($start -lt 0 -or $end -lt 0) {
        throw "Missing runbook section boundary: $StartHeading -> $EndHeading"
    }

    $runbook.Substring($start, $end - $start)
}

Describe 'CodexAPI production runbook contract' {
    $routine = Get-RunbookSection `
        -StartHeading '## Routine Codex API Deployment' `
        -EndHeading '## Full VM Bootstrap'
    $recovery = Get-RunbookSection `
        -StartHeading '### CodexAPI previous-commit recovery' `
        -EndHeading '### Ludora admin rollback'

    It 'deploys only an exact approved commit from a clean checkout after stopping the service' {
        $routine | Should Match "CODEXAPI_COMMIT='<approved full 40-character commit SHA>'"
        $routine | Should Match 'test "\$\(git rev-parse origin/main\)" = "\$CODEXAPI_COMMIT"'
        $routine | Should Match 'test -z "\$\(git status --porcelain\)"'

        $stop = $routine.IndexOf('sudo systemctl stop codexapi.service', [StringComparison]::Ordinal)
        $checkout = $routine.IndexOf('git checkout main', [StringComparison]::Ordinal)
        $npmInstall = $routine.IndexOf('npm ci', [StringComparison]::Ordinal)
        ($stop -ge 0 -and $stop -lt $checkout -and $stop -lt $npmInstall) | Should Be $true
    }

    It 'installs the checked-in unit and verifies the capable isolated health and filesystem boundary' {
        $routine | Should Match 'deploy/codexapi\.service /etc/systemd/system/codexapi\.service'
        $routine | Should Match 'systemd-analyze verify /etc/systemd/system/codexapi\.service'
        $routine | Should Match 'verify_codexapi_startup\(\)'
        $routine | Should Match 'codexapi-capable-isolated-v2'
        $routine | Should Match 'codexCli\.version'
        $routine | Should Match 'codexCli\.version !== "0\.147\.0"'
        $routine | Should Match "ss -H -ltn 'sport = :3001'"
        $routine | Should Match 'systemctl show .*codexapi\.service'
        $routine | Should Match 'User=codexapi'
        $routine | Should Match 'ProtectSystem=strict'
        $routine | Should Match 'ProtectHome=true'
        $routine | Should Match 'ReadWritePaths=/var/lib/codexapi'
        $routine | Should Match 'InaccessiblePaths=/opt/ludora/ludora-admin /home /root'
        $routine | Should Match 'cmp -s deploy/codexapi-runtime\.config\.toml /var/lib/codexapi/home/codexapi-runtime\.config\.toml'
        $routine | Should Match "stat -c '%a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
    }

    It 'deploys the admin service and runs the database-free BGG canary only after CodexAPI verification' {
        $verified = $routine.IndexOf('if ! verify_codexapi_startup; then', [StringComparison]::Ordinal)
        $adminDeployment = $routine.IndexOf('After CodexAPI verification succeeds, deploy the approved admin-service revision through the existing routine admin deployment procedure.', [StringComparison]::Ordinal)
        $canary = $routine.IndexOf('npm run verify:ai-bgg', [StringComparison]::Ordinal)

        ($verified -ge 0 -and $adminDeployment -gt $verified -and $canary -gt $adminDeployment) | Should Be $true
        $routine | Should Match 'npm run verify:ai-bgg'
        $routine | Should Not Match '(?i)psql|database/schema\.sql|database/patches|LUDORA_DATABASE_URL'
    }

    It 'stops the service when post-start verification fails in deployment and recovery' {
        foreach ($section in @($routine, $recovery)) {
            $section | Should Match '(?s)sudo systemctl start codexapi\.service.*if ! verify_codexapi_startup; then\s+sudo systemctl stop codexapi\.service\s+exit 1\s+fi'
            $section | Should Match '(?s)if ! verify_codexapi_boundary; then\s+sudo systemctl stop codexapi\.service\s+exit 1\s+fi'
        }
        $agents | Should Match '(?s)post-start verification fails.*stop `codexapi\.service`'
    }

    It 'applies capable isolated health and runtime-profile verification during recovery' {
        $recovery | Should Match 'codexapi-capable-isolated-v2'
        $recovery | Should Match 'systemctl show .*codexapi\.service'
        $recovery | Should Match 'cmp -s deploy/codexapi-runtime\.config\.toml /var/lib/codexapi/home/codexapi-runtime\.config\.toml'
        $recovery | Should Match "stat -c '%a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
    }

    It 'provides explicit previous-commit recovery before npm mutation' {
        $recovery | Should Match "CODEXAPI_PREVIOUS_COMMIT='<previous full 40-character commit SHA>'"
        $recovery | Should Match 'git checkout --detach "\$CODEXAPI_PREVIOUS_COMMIT"'

        $stop = $recovery.IndexOf('sudo systemctl stop codexapi.service', [StringComparison]::Ordinal)
        $npmInstall = $recovery.IndexOf('npm ci', [StringComparison]::Ordinal)
        ($stop -ge 0 -and $stop -lt $npmInstall) | Should Be $true
    }

    It 'does not restore obsolete inline, global, or custom-controller deployment paths' {
        $runbook | Should Not Match 'sudo npm install -g @openai/codex'
        $runbook | Should Not Match '(?s)Create `/etc/systemd/system/codexapi\.service`.*?```ini'
        $runbook | Should Not Match 'codexapi-deploy\.mjs|deployment-journal|/opt/ludora/releases|immutable release'
    }
}
