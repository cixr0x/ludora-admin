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
        $routine | Should Match 'ProtectHome=yes'
        $routine | Should Not Match 'ProtectHome=true'
        $routine | Should Match 'ReadWritePaths=/var/lib/codexapi'
        $routine | Should Match 'InaccessiblePaths=/opt/ludora/ludora-admin /home /root'
        $routine | Should Match 'cmp -s deploy/codexapi-runtime\.config\.toml /var/lib/codexapi/home/codexapi-runtime\.config\.toml'
        $routine | Should Match "stat -c '%a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
    }

    It 'orders routine CodexAPI deployment through verification before admin deployment and the database-free canary' {
        $stop = $routine.IndexOf('sudo systemctl stop codexapi.service', [StringComparison]::Ordinal)
        $checkout = $routine.IndexOf('git checkout main', [StringComparison]::Ordinal)
        $npmInstall = $routine.IndexOf('npm ci', [StringComparison]::Ordinal)
        $npmBuild = $routine.IndexOf('npm run build', [StringComparison]::Ordinal)
        $unitInstall = $routine.IndexOf('deploy/codexapi.service /etc/systemd/system/codexapi.service', [StringComparison]::Ordinal)
        $profileInstall = $routine.IndexOf('deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $unitVerify = $routine.IndexOf('sudo systemd-analyze verify /etc/systemd/system/codexapi.service', [StringComparison]::Ordinal)
        $start = $routine.IndexOf('sudo systemctl start codexapi.service', [StringComparison]::Ordinal)
        $startupVerification = $routine.IndexOf('if ! verify_codexapi_startup; then', [StringComparison]::Ordinal)
        $boundaryVerification = $routine.IndexOf('if ! verify_codexapi_boundary; then', [StringComparison]::Ordinal)
        $adminDeployment = $routine.IndexOf('After CodexAPI verification succeeds, deploy the approved admin-service revision through the existing routine admin deployment procedure.', [StringComparison]::Ordinal)
        $canary = $routine.IndexOf('npm run verify:ai-bgg', [StringComparison]::Ordinal)

        ($stop -ge 0 -and $checkout -gt $stop -and $npmInstall -gt $checkout -and $npmBuild -gt $npmInstall -and
            $unitInstall -gt $npmBuild -and $profileInstall -gt $unitInstall -and $unitVerify -gt $profileInstall -and
            $start -gt $unitVerify -and $startupVerification -gt $start -and $boundaryVerification -gt $startupVerification -and
            $adminDeployment -gt $boundaryVerification -and $canary -gt $adminDeployment) | Should Be $true
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

    It 'makes recovery revision-aware while preserving core CodexAPI isolation checks' {
        $recovery | Should Match "CODEXAPI_PREVIOUS_CAPABILITY_POLICY='<expected health capability policy for selected commit>'"
        $recovery | Should Match 'test "\$CODEXAPI_PREVIOUS_CAPABILITY_POLICY" != ''<expected health capability policy for selected commit>'''
        $recovery | Should Match 'EXPECTED_CODEXAPI_CAPABILITY_POLICY="\$CODEXAPI_PREVIOUS_CAPABILITY_POLICY"'
        $recovery | Should Not Match 'codexapi-capable-isolated-v2'
        $recovery | Should Match 'systemctl show .*codexapi\.service'
        $recovery | Should Match '(?s)systemctl show codexapi\.service\s+\\?\s*--property=User.*--property=ReadOnlyPaths.*--property=InaccessiblePaths'
        $recovery | Should Match 'ProtectHome=yes'
        $recovery | Should Match 'ReadOnlyPaths=/opt/ludora/codexapi'
        $recovery | Should Match 'InaccessiblePaths=.*opt/ludora/ludora-admin'
        $recovery | Should Match 'InaccessiblePaths=.*home'
        $recovery | Should Match 'cmp -s deploy/codexapi\.service /etc/systemd/system/codexapi\.service'
    }

    It 'supports the known first-rollout recovery revision without a runtime profile' {
        $recovery | Should Match '5332ab156fa37350a3addd2b385692264fc17c3c'
        $recovery | Should Match 'codexapi-constrained-v1'
        $recovery | Should Not Match '(?m)^test -f deploy/codexapi-runtime\.config\.toml$'

        $profileIf = $recovery.IndexOf('if test -f deploy/codexapi-runtime.config.toml; then', [StringComparison]::Ordinal)
        $profileElse = $recovery.IndexOf('else', [StringComparison]::Ordinal)
        $noProfileReference = $recovery.IndexOf("! grep -Fq 'codexapi-runtime.config.toml' deploy/codexapi.service", [StringComparison]::Ordinal)
        $profileRemove = $recovery.IndexOf('sudo rm -f /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $profileAbsent = $recovery.IndexOf('test ! -e /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)

        ($profileIf -ge 0 -and $profileElse -gt $profileIf -and $noProfileReference -gt $profileElse -and
            $profileRemove -gt $noProfileReference -and $profileAbsent -gt $profileRemove) | Should Be $true
    }

    It 'installs and verifies the selected revision runtime profile when present' {
        $profileIf = $recovery.IndexOf('if test -f deploy/codexapi-runtime.config.toml; then', [StringComparison]::Ordinal)
        $preinstallContract = $recovery.IndexOf("grep -Fx 'ExecStartPre=/usr/bin/install -m 0400 /opt/ludora/codexapi/deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml' deploy/codexapi.service", [StringComparison]::Ordinal)
        $profileInstall = $recovery.IndexOf('sudo install -o codexapi -g codexapi -m 0400', [StringComparison]::Ordinal)
        $profileInstallPath = $profileInstall + $recovery.Substring($profileInstall).IndexOf('deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $profilePresent = $recovery.IndexOf('CODEXAPI_RUNTIME_PROFILE_PRESENT=true', [StringComparison]::Ordinal)
        $conditionalVerification = $recovery.IndexOf('if test "$CODEXAPI_RUNTIME_PROFILE_PRESENT" = true; then', [StringComparison]::Ordinal)
        $profileCompare = $recovery.IndexOf('cmp -s deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $profileMode = $recovery.IndexOf("stat -c '%a' /var/lib/codexapi/home/codexapi-runtime.config.toml", [StringComparison]::Ordinal)

        ($profileIf -ge 0 -and $preinstallContract -gt $profileIf -and $profileInstall -gt $preinstallContract -and
            $profileInstallPath -gt $profileInstall -and $profilePresent -gt $profileInstallPath -and $conditionalVerification -gt $profilePresent -and
            $profileCompare -gt $conditionalVerification -and $profileMode -gt $profileCompare) | Should Be $true
    }

    It 'orders recovery through the selected revision unit/profile and fail-closed verification' {
        $stop = $recovery.IndexOf('sudo systemctl stop codexapi.service', [StringComparison]::Ordinal)
        $checkout = $recovery.IndexOf('git checkout --detach "$CODEXAPI_PREVIOUS_COMMIT"', [StringComparison]::Ordinal)
        $npmInstall = $recovery.IndexOf('npm ci', [StringComparison]::Ordinal)
        $npmBuild = $recovery.IndexOf('npm run build', [StringComparison]::Ordinal)
        $unitInstall = $recovery.IndexOf('deploy/codexapi.service /etc/systemd/system/codexapi.service', [StringComparison]::Ordinal)
        $profileInstall = $recovery.IndexOf('deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $unitVerify = $recovery.IndexOf('sudo systemd-analyze verify /etc/systemd/system/codexapi.service', [StringComparison]::Ordinal)
        $start = $recovery.IndexOf('sudo systemctl start codexapi.service', [StringComparison]::Ordinal)
        $startupVerification = $recovery.IndexOf('if ! verify_codexapi_startup; then', [StringComparison]::Ordinal)
        $boundaryVerification = $recovery.IndexOf('if ! verify_codexapi_boundary; then', [StringComparison]::Ordinal)

        ($stop -ge 0 -and $checkout -gt $stop -and $npmInstall -gt $checkout -and $npmBuild -gt $npmInstall -and
            $unitInstall -gt $npmBuild -and $profileInstall -gt $unitInstall -and $unitVerify -gt $profileInstall -and
            $start -gt $unitVerify -and $startupVerification -gt $start -and $boundaryVerification -gt $startupVerification) | Should Be $true
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
