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

function Get-CodexApiReadinessFunction {
    param([Parameter(Mandatory = $true)][string]$Section)

    $match = [regex]::Match(
        $Section,
        '(?s)verify_codexapi_startup\(\) \{.*?^\}',
        [System.Text.RegularExpressions.RegexOptions]::Multiline
    )
    if (-not $match.Success) {
        throw 'Missing verify_codexapi_startup function.'
    }

    $match.Value
}

function ConvertTo-GitBashPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ($Path -notmatch '^[A-Za-z]:\\') {
        throw "Expected an absolute Windows path: $Path"
    }

    ('/{0}/{1}' -f $Path.Substring(0, 1).ToLowerInvariant(), $Path.Substring(3).Replace('\', '/'))
}

function Invoke-CodexApiReadinessHarness {
    param(
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$ExpectedPolicy
    )

    $gitBash = 'C:\Program Files\Git\bin\bash.exe'
    if (-not (Test-Path -LiteralPath $gitBash)) {
        throw "Git Bash is required for readiness tests: $gitBash"
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ludora-codexapi-readiness-{0}" -f [guid]::NewGuid())
    [System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)

    $functionPath = Join-Path $tempRoot 'readiness-function.sh'
    $harnessPath = Join-Path $tempRoot 'run-readiness.sh'
    $tracePath = Join-Path $tempRoot 'trace.log'
    $curlCountPath = Join-Path $tempRoot 'curl-count'
    $sleepCountPath = Join-Path $tempRoot 'sleep-count'
    [System.IO.File]::WriteAllText($functionPath, (Get-CodexApiReadinessFunction -Section $Section), $utf8)
    [System.IO.File]::WriteAllText($curlCountPath, '0', $utf8)
    [System.IO.File]::WriteAllText($sleepCountPath, '0', $utf8)

    $bashFunctionPath = ConvertTo-GitBashPath -Path $functionPath
    [System.IO.File]::WriteAllText($harnessPath, @'
#!/usr/bin/env bash
set -euo pipefail
sudo() {
  "$@"
}
systemctl() {
  printf 'systemctl %s\n' "$*" >> "$TRACE_FILE"
  if [ "$1" = is-active ] && [ "$2" = --quiet ]; then
    local count=0
    read -r count < "$CURL_COUNT"
    case "$SCENARIO" in
      inactive-after-failure|malformed-then-inactive|wrong-policy-then-inactive)
        [ "$count" -eq 0 ] || return 3
        ;;
    esac
  fi
  return 0
}
curl() {
  local count=0
  read -r count < "$CURL_COUNT"
  count=$((count + 1))
  printf '%s' "$count" > "$CURL_COUNT"
  printf 'curl %s\n' "$count" >> "$TRACE_FILE"
  case "$SCENARIO" in
    third-success)
      [ "$count" -lt 3 ] && return 22
      printf '{"status":"ok","capabilityPolicy":"%s","codexCli":{"version":"0.147.0","checked":true}}' "$HEALTH_POLICY"
      ;;
    inactive-after-failure|all-fail)
      return 22
      ;;
    malformed|malformed-then-inactive)
      printf '{not-json'
      ;;
    wrong-policy|wrong-policy-then-inactive)
      printf '{"status":"ok","capabilityPolicy":"wrong-policy","codexCli":{"version":"0.147.0","checked":true}}'
      ;;
    *)
      printf 'Unknown scenario: %s\n' "$SCENARIO" >&2
      return 64
      ;;
  esac
}
node() {
  local body
  body="$(cat)"
  [[ "$body" == *'"status":"ok"'* &&
    "$body" == *"\"capabilityPolicy\":\"$HEALTH_POLICY\""* &&
    "$body" == *'"version":"0.147.0"'* &&
    "$body" == *'"checked":true'* ]]
}
ss() {
  printf 'ss %s\n' "$*" >> "$TRACE_FILE"
  printf 'LISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*\n'
}
sleep() {
  local count=0
  read -r count < "$SLEEP_COUNT"
  count=$((count + 1))
  printf '%s' "$count" > "$SLEEP_COUNT"
  printf 'sleep %s\n' "$*" >> "$TRACE_FILE"
}
source "$READINESS_FUNCTION"
CODEXAPI_PREVIOUS_CAPABILITY_POLICY="$EXPECTED_POLICY"
if ! verify_codexapi_startup; then
  printf 'READINESS_RESULT=nonzero\n'
else
  printf 'READINESS_RESULT=zero\n'
fi
printf 'GUARDED_CALLER_REACHED=yes\n'
'@, $utf8)
    $bashHarnessPath = ConvertTo-GitBashPath -Path $harnessPath

    $environment = @{
        'READINESS_FUNCTION' = $bashFunctionPath
        'TRACE_FILE' = (ConvertTo-GitBashPath -Path $tracePath)
        'CURL_COUNT' = (ConvertTo-GitBashPath -Path $curlCountPath)
        'SLEEP_COUNT' = (ConvertTo-GitBashPath -Path $sleepCountPath)
        'SCENARIO' = $Scenario
        'EXPECTED_POLICY' = $ExpectedPolicy
        'HEALTH_POLICY' = $ExpectedPolicy
    }
    $previousEnvironment = @{}
    try {
        foreach ($entry in $environment.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [System.Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $output = (& $gitBash --noprofile --norc $bashHarnessPath 2>&1 | Out-String)
        $stopwatch.Stop()
        $exitCode = $LASTEXITCODE
    }
    finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }

    try {
        [pscustomobject]@{
            ExitCode = $exitCode
            Output = $output
            Trace = if (Test-Path -LiteralPath $tracePath) { [System.IO.File]::ReadAllLines($tracePath) } else { @() }
            CurlCount = [int][System.IO.File]::ReadAllText($curlCountPath)
            SleepCount = [int][System.IO.File]::ReadAllText($sleepCountPath)
            ElapsedMilliseconds = $stopwatch.ElapsedMilliseconds
        }
    }
    finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-CodexApiBoundaryFunction {
    param([Parameter(Mandatory = $true)][string]$Section)

    $match = [regex]::Match(
        $Section,
        '(?s)verify_codexapi_boundary\(\) \{.*?^\}',
        [System.Text.RegularExpressions.RegexOptions]::Multiline
    )
    if (-not $match.Success) {
        throw 'Missing verify_codexapi_boundary function.'
    }

    $match.Value
}

function Invoke-CodexApiProfileBoundaryHarness {
    param(
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][bool]$RuntimeProfilePresent
    )

    $gitBash = 'C:\Program Files\Git\bin\bash.exe'
    if (-not (Test-Path -LiteralPath $gitBash)) {
        throw "Git Bash is required for boundary tests: $gitBash"
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ludora-codexapi-boundary-{0}" -f [guid]::NewGuid())
    $stubDirectory = Join-Path $tempRoot 'bin'
    [System.IO.Directory]::CreateDirectory($stubDirectory) | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $functionPath = Join-Path $tempRoot 'boundary-function.sh'
    $harnessPath = Join-Path $tempRoot 'run-boundary.sh'
    $tracePath = Join-Path $tempRoot 'trace.log'
    [System.IO.File]::WriteAllText($functionPath, (Get-CodexApiBoundaryFunction -Section $Section), $utf8)

    $stubs = @{
        'sudo' = @'
#!/usr/bin/env bash
AS_SUDO=true "$@"
'@
        'systemctl' = @'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$TRACE_FILE"
cat <<'UNIT'
User=codexapi
Group=codexapi
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/opt/ludora/codexapi
ReadWritePaths=/var/lib/codexapi
InaccessiblePaths=/opt/ludora/ludora-admin /home /root
UNIT
'@
        'grep' = @'
#!/usr/bin/env bash
exec /usr/bin/grep "$@"
'@
        'cmp' = @'
#!/usr/bin/env bash
if [[ "$*" == *codexapi-runtime.config.toml* ]]; then
  if [ "${AS_SUDO:-}" != true ]; then
    printf 'cmp: Permission denied\n' >&2
    exit 2
  fi
  printf 'sudo cmp %s\n' "$*" >> "$TRACE_FILE"
  exit 0
fi
printf 'direct cmp %s\n' "$*" >> "$TRACE_FILE"
exit 0
'@
        'stat' = @'
#!/usr/bin/env bash
if [ "${AS_SUDO:-}" != true ]; then
  printf 'stat: Permission denied\n' >&2
  exit 1
fi
printf 'sudo stat %s\n' "$*" >> "$TRACE_FILE"
printf 'codexapi:codexapi 400\n'
'@
    }
    foreach ($stub in $stubs.GetEnumerator()) {
        [System.IO.File]::WriteAllText((Join-Path $stubDirectory $stub.Key), $stub.Value, $utf8)
    }

    $bashStubDirectory = ConvertTo-GitBashPath -Path $stubDirectory
    $bashFunctionPath = ConvertTo-GitBashPath -Path $functionPath
    [System.IO.File]::WriteAllText($harnessPath, @'
#!/usr/bin/env bash
set -euo pipefail
PATH="$STUB_DIRECTORY:$PATH"
source "$BOUNDARY_FUNCTION"
CODEXAPI_RUNTIME_PROFILE_PRESENT="$RUNTIME_PROFILE_PRESENT"
if ! verify_codexapi_boundary; then
  printf 'BOUNDARY_RESULT=nonzero\n'
else
  printf 'BOUNDARY_RESULT=zero\n'
fi
printf 'GUARDED_CALLER_REACHED=yes\n'
'@, $utf8)
    $bashHarnessPath = ConvertTo-GitBashPath -Path $harnessPath
    $environment = @{
        'STUB_DIRECTORY' = $bashStubDirectory
        'BOUNDARY_FUNCTION' = $bashFunctionPath
        'TRACE_FILE' = (ConvertTo-GitBashPath -Path $tracePath)
        'RUNTIME_PROFILE_PRESENT' = $RuntimeProfilePresent.ToString().ToLowerInvariant()
    }
    $previousEnvironment = @{}
    try {
        foreach ($entry in $environment.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [System.Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        & $gitBash -c 'chmod +x "$1"/*' bash $bashStubDirectory
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not make Git Bash boundary stubs executable.'
        }
        $output = (& $gitBash --noprofile --norc $bashHarnessPath 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }

    try {
        [pscustomobject]@{
            ExitCode = $exitCode
            Output = $output
            Trace = if (Test-Path -LiteralPath $tracePath) { [System.IO.File]::ReadAllLines($tracePath) } else { @() }
        }
    }
    finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
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
        $routine | Should Match 'sudo cmp -s deploy/codexapi-runtime\.config\.toml /var/lib/codexapi/home/codexapi-runtime\.config\.toml'
        $routine | Should Match "sudo stat -c '%U:%G %a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
    }

    It 'verifies readable runtime profiles through sudo with exact owner and mode' {
        foreach ($section in @($routine, $recovery)) {
            $boundary = Get-CodexApiBoundaryFunction -Section $section
            $boundary | Should Match 'sudo cmp -s deploy/codexapi-runtime\.config\.toml /var/lib/codexapi/home/codexapi-runtime\.config\.toml'
            $boundary | Should Match "sudo stat -c '%U:%G %a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
            $boundary | Should Match 'codexapi:codexapi 400'
            $boundary | Should Not Match '(?m)^\s*cmp -s deploy/codexapi-runtime\.config\.toml'
            $boundary | Should Not Match "(?m)^\s*test .*stat -c '%a' /var/lib/codexapi/home/codexapi-runtime\.config\.toml"
        }
    }

    It 'executes profile boundary checks as sudo without exposing profile contents' {
        foreach ($section in @($routine, $recovery)) {
            $result = Invoke-CodexApiProfileBoundaryHarness -Section $section -RuntimeProfilePresent $true

            $result.ExitCode | Should Be 0
            $result.Output | Should Match 'BOUNDARY_RESULT=zero'
            $result.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
            $result.Output | Should Not Match '(?i)profile|secret|token'
            ($result.Trace -contains 'sudo cmp -s deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml') | Should Be $true
            @($result.Trace | Where-Object { $_ -match '^sudo stat -c %U:%G %a /var/lib/codexapi/home/codexapi-runtime\.config\.toml$' }).Count | Should Be 1
        }
    }

    It 'retries the routine readiness function until the third valid health contract before listener checks' {
        $result = Invoke-CodexApiReadinessHarness -Section $routine -Scenario third-success -ExpectedPolicy 'codexapi-capable-isolated-v2'

        $result.ExitCode | Should Be 0
        $result.Output | Should Match 'READINESS_RESULT=zero'
        $result.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
        $result.CurlCount | Should Be 3
        $result.SleepCount | Should Be 2
        ($result.ElapsedMilliseconds -lt 3000) | Should Be $true
        @($result.Trace | Where-Object { $_ -like 'ss *' }).Count | Should Be 2
        $firstListener = [array]::IndexOf($result.Trace, @($result.Trace | Where-Object { $_ -like 'ss *' })[0])
        $lastHealth = [array]::IndexOf($result.Trace, 'curl 3')
        ($firstListener -gt $lastHealth) | Should Be $true
    }

    It 'fails fast after an unsuccessful health attempt when CodexAPI becomes inactive' {
        foreach ($section in @($routine, $recovery)) {
            $policy = if ($section -eq $routine) { 'codexapi-capable-isolated-v2' } else { 'selected-recovery-policy' }
            $result = Invoke-CodexApiReadinessHarness -Section $section -Scenario inactive-after-failure -ExpectedPolicy $policy

            $result.ExitCode | Should Be 0
            $result.Output | Should Match 'READINESS_RESULT=nonzero'
            $result.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
            $result.Output | Should Not Match 'Unknown scenario'
            $result.CurlCount | Should Be 1
            $result.SleepCount | Should Be 1
            @($result.Trace | Where-Object { $_ -like 'ss *' }).Count | Should Be 0
        }
    }

    It 'bounds active failed readiness attempts with sleeps only between attempts' {
        foreach ($section in @($routine, $recovery)) {
            $policy = if ($section -eq $routine) { 'codexapi-capable-isolated-v2' } else { 'selected-recovery-policy' }
            $result = Invoke-CodexApiReadinessHarness -Section $section -Scenario all-fail -ExpectedPolicy $policy

            $result.ExitCode | Should Be 0
            $result.Output | Should Match 'READINESS_RESULT=nonzero'
            $result.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
            $result.CurlCount | Should Be 40
            $result.SleepCount | Should Be 39
            ($result.ElapsedMilliseconds -lt 3000) | Should Be $true
            @($result.Trace | Where-Object { $_ -like 'ss *' }).Count | Should Be 0
        }
    }

    It 'rejects malformed and wrong-policy health from the extracted readiness functions' {
        foreach ($scenario in @('malformed-then-inactive', 'wrong-policy-then-inactive')) {
            $routineResult = Invoke-CodexApiReadinessHarness -Section $routine -Scenario $scenario -ExpectedPolicy 'codexapi-capable-isolated-v2'
            $routineResult.Output | Should Match 'READINESS_RESULT=nonzero'
            $routineResult.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
            ($routineResult.ElapsedMilliseconds -lt 3000) | Should Be $true
            @($routineResult.Trace | Where-Object { $_ -like 'ss *' }).Count | Should Be 0

            $recoveryResult = Invoke-CodexApiReadinessHarness -Section $recovery -Scenario $scenario -ExpectedPolicy 'selected-recovery-policy'
            $recoveryResult.Output | Should Match 'READINESS_RESULT=nonzero'
            $recoveryResult.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
            ($recoveryResult.ElapsedMilliseconds -lt 3000) | Should Be $true
            @($recoveryResult.Trace | Where-Object { $_ -like 'ss *' }).Count | Should Be 0
        }
    }

    It 'uses the selected recovery capability policy for an otherwise valid health contract' {
        $matching = Invoke-CodexApiReadinessHarness -Section $recovery -Scenario third-success -ExpectedPolicy 'selected-recovery-policy'
        $wrong = Invoke-CodexApiReadinessHarness -Section $recovery -Scenario wrong-policy -ExpectedPolicy 'selected-recovery-policy'

        $matching.Output | Should Match 'READINESS_RESULT=zero'
        $matching.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
        ($matching.ElapsedMilliseconds -lt 3000) | Should Be $true
        $wrong.Output | Should Match 'READINESS_RESULT=nonzero'
        $wrong.Output | Should Match 'GUARDED_CALLER_REACHED=yes'
        ($wrong.ElapsedMilliseconds -lt 3000) | Should Be $true
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
        $canary = $routine.IndexOf('npm run --silent verify:ai-bgg', [StringComparison]::Ordinal)

        ($stop -ge 0 -and $checkout -gt $stop -and $npmInstall -gt $checkout -and $npmBuild -gt $npmInstall -and
            $unitInstall -gt $npmBuild -and $profileInstall -gt $unitInstall -and $unitVerify -gt $profileInstall -and
            $start -gt $unitVerify -and $startupVerification -gt $start -and $boundaryVerification -gt $startupVerification -and
            $adminDeployment -gt $boundaryVerification -and $canary -gt $adminDeployment) | Should Be $true
        $routine | Should Match 'npm run --silent verify:ai-bgg'
        $routine | Should Not Match '(?i)psql|database/schema\.sql|database/patches|LUDORA_DATABASE_URL'
    }

    It 'documents the exact reviewed SHA and hermetic isolation tests before VM deployment' {
        $routine | Should Match 'exact reviewed\s+CodexAPI SHA'
        $routine | Should Match '(?s)Before push or deployment.*full `npm test`.*hermetic isolation-canary tests'
    }

    It 'runs exact-output live isolation gates before admin activation and after the BGG canary' {
        $boundaryVerification = $routine.IndexOf('if ! verify_codexapi_boundary; then', [StringComparison]::Ordinal)
        $firstIsolationCommand = $routine.IndexOf('sudo npm run --silent verify:isolation', [StringComparison]::Ordinal)
        $adminDeployment = $routine.IndexOf('After CodexAPI verification succeeds, deploy the approved admin-service revision through the existing routine admin deployment procedure.', [StringComparison]::Ordinal)
        $bggCommand = $routine.IndexOf('npm run --silent verify:ai-bgg', [StringComparison]::Ordinal)
        $bggComparison = $routine.IndexOf('test "$AI_BGG_OUTPUT" != $''{"status":"ok","bggId":296354}\n\036''', [StringComparison]::Ordinal)
        $secondIsolationCommand = $routine.LastIndexOf('sudo npm run --silent verify:isolation', [StringComparison]::Ordinal)

        ($boundaryVerification -ge 0 -and $firstIsolationCommand -gt $boundaryVerification -and
            $adminDeployment -gt $firstIsolationCommand -and $bggCommand -gt $adminDeployment -and
            $bggComparison -gt $bggCommand -and $secondIsolationCommand -gt $bggComparison -and
            $secondIsolationCommand -gt $firstIsolationCommand) | Should Be $true
        ([regex]::Matches($routine, [regex]::Escape('sudo npm run --silent verify:isolation')).Count) | Should Be 2
        ([regex]::Matches($routine, [regex]::Escape("printf '\036'")).Count) | Should Be 3
        $routine | Should Match 'test "\$AI_BGG_OUTPUT" != \$''\{"status":"ok","bggId":296354\}\\n\\036'''
        ([regex]::Matches($routine, 'test "\$CODEXAPI_ISOLATION_OUTPUT" != \$''\{"status":"ok","isolation":"verified"\}\\n\\036''').Count) | Should Be 2
    }

    It 'fail closes before either post-admin canary when admin setup is not ready' {
        $guardedAdminCd = $routine.IndexOf('if ! cd /opt/ludora/ludora-admin/ludora-admin-service; then', [StringComparison]::Ordinal)
        $guardedAdminActive = $routine.IndexOf('if ! sudo systemctl is-active --quiet ludora-admin-service.service; then', [StringComparison]::Ordinal)
        $bggCommand = $routine.IndexOf('npm run --silent verify:ai-bgg', [StringComparison]::Ordinal)

        ($guardedAdminCd -ge 0 -and $guardedAdminActive -gt $guardedAdminCd -and
            $bggCommand -gt $guardedAdminActive) | Should Be $true
        $routine | Should Match '(?s)if ! cd /opt/ludora/ludora-admin/ludora-admin-service; then\s+sudo systemctl stop ludora-admin-service\.service codexapi\.service\s+exit 1\s+fi'
        $routine | Should Match '(?s)if ! sudo systemctl is-active --quiet ludora-admin-service\.service; then\s+sudo systemctl stop ludora-admin-service\.service codexapi\.service\s+exit 1\s+fi'
    }

    It 'stops the appropriate services when a live isolation gate fails' {
        $routine | Should Match '(?s)# Candidate/pre-admin activation isolation gate\..*sudo npm run --silent verify:isolation.*test "\$CODEXAPI_ISOLATION_OUTPUT" != \$''\{"status":"ok","isolation":"verified"\}\\n\\036''; then\s+sudo systemctl stop codexapi\.service\s+exit 1'
        $routine | Should Match '(?s)# Final post-deployment isolation gate\..*sudo npm run --silent verify:isolation.*test "\$CODEXAPI_ISOLATION_OUTPUT" != \$''\{"status":"ok","isolation":"verified"\}\\n\\036''; then\s+sudo systemctl stop ludora-admin-service\.service\s+sudo systemctl stop codexapi\.service\s+exit 1'
        $routine | Should Match 'leave both services stopped and use\s+the rollback\s+procedures'
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
        $profileCompare = $recovery.IndexOf('sudo cmp -s deploy/codexapi-runtime.config.toml /var/lib/codexapi/home/codexapi-runtime.config.toml', [StringComparison]::Ordinal)
        $profileMode = $recovery.IndexOf("sudo stat -c '%U:%G %a' /var/lib/codexapi/home/codexapi-runtime.config.toml", [StringComparison]::Ordinal)

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

    It 'runs recovery isolation only when the selected revision owns the script' {
        $recovery | Should Match 'After restoring the exact selected admin revision'
        $probe = $recovery.IndexOf('if ! CODEXAPI_ISOLATION_OWNERSHIP="$(node -e', [StringComparison]::Ordinal)
        $present = $recovery.IndexOf('  present)', [StringComparison]::Ordinal)
        $canary = $recovery.IndexOf('sudo npm run --silent verify:isolation', [StringComparison]::Ordinal)
        $absent = $recovery.IndexOf('  absent)', [StringComparison]::Ordinal)
        $unexpected = $recovery.IndexOf('  *)', [StringComparison]::Ordinal)

        ($probe -ge 0 -and $present -gt $probe -and $canary -gt $present -and
            $absent -gt $canary -and $unexpected -gt $absent) | Should Be $true
        $recovery | Should Match 'JSON\.parse\(fs\.readFileSync\("\./package\.json", "utf8"\)\)'
        $recovery | Should Match 'process\.stdout\.write\(Object\.hasOwn\(scripts \?\? \{\}, "verify:isolation"\) \? "present" : "absent"\)'
        $recovery | Should Match 'process\.exitCode = 0'
        $recovery | Should Match '(?s)present\).*sudo npm run --silent verify:isolation.*\{"status":"ok","isolation":"verified"\}.*sudo systemctl stop ludora-admin-service\.service codexapi\.service\s+exit 1'
        $recovery | Should Match '(?s)5332ab156fa37350a3addd2b385692264fc17c3c.*exact `absent`'
        $recovery | Should Match 'skips that unavailable future canary'
        $recovery | Should Not Match '(?i)psql|database/schema\.sql|database/patches|LUDORA_DATABASE_URL'
    }

    It 'treats probe errors and unexpected ownership output as fail-closed recovery errors' {
        $recovery | Should Match '(?s)if ! CODEXAPI_ISOLATION_OWNERSHIP="\$\(node -e .*verify:isolation.*\)"; then\s+sudo systemctl stop ludora-admin-service\.service codexapi\.service\s+exit 1\s+fi'
        $recovery | Should Match '(?s)\*\)\s+sudo systemctl stop ludora-admin-service\.service codexapi\.service\s+exit 1\s+;;'
        $recovery | Should Match 'including exit `127` when `node` is unavailable'
        $recovery | Should Match 'unexpected probe output'
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
