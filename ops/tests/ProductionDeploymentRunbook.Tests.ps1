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

    It 'installs the checked-in unit and verifies health, startup attestation, and listener state' {
        $routine | Should Match 'deploy/codexapi\.service /etc/systemd/system/codexapi\.service'
        $routine | Should Match 'verify_codexapi_startup\(\)'
        $routine | Should Match 'codexapi-constrained-v1'
        $routine | Should Match 'codexCli\.version'
        $routine | Should Match "ss -H -ltn 'sport = :3001'"
    }

    It 'stops the service when post-start verification fails in deployment and recovery' {
        foreach ($section in @($routine, $recovery)) {
            $section | Should Match '(?s)sudo systemctl start codexapi\.service.*if ! verify_codexapi_startup; then\s+sudo systemctl stop codexapi\.service\s+exit 1\s+fi'
        }
        $agents | Should Match '(?s)post-start verification fails.*stop `codexapi\.service`'
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
