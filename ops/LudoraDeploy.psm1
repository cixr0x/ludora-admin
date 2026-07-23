Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:LudoraDeployModuleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-LudoraFullCommit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Commit
    )

    if ($Commit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'ExpectedCommit must be a full 40-character Git commit SHA.'
    }

    return $Commit.ToLowerInvariant()
}

function ConvertTo-LudoraBase64 {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function ConvertTo-LudoraGzipBase64 {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $inputBytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $outputStream = New-Object IO.MemoryStream
    try {
        $gzipStream = New-Object IO.Compression.GZipStream($outputStream, [IO.Compression.CompressionMode]::Compress, $true)
        try {
            $gzipStream.Write($inputBytes, 0, $inputBytes.Length)
        }
        finally {
            $gzipStream.Dispose()
        }
        return [Convert]::ToBase64String($outputStream.ToArray())
    }
    finally {
        $outputStream.Dispose()
    }
}

function ConvertTo-LudoraBashLiteral {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $escapedSingleQuote = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    return $singleQuote + $Value.Replace($singleQuote, $escapedSingleQuote) + $singleQuote
}

function Read-LudoraDeployConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    $resolvedPath = (Resolve-Path -LiteralPath $ConfigPath).Path
    $config = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
    $requiredProperties = @(
        'schemaVersion',
        'gcpProject',
        'instance',
        'zone',
        'machineType',
        'sshUser',
        'expectedExternalIp',
        'publicHost',
        'adminCheckout',
        'originUrl'
    )

    foreach ($property in $requiredProperties) {
        if ($config.PSObject.Properties.Name -notcontains $property) {
            throw "Deployment config is missing required property '$property'."
        }
    }

    if ([string]$config.schemaVersion -ne '1') {
        throw "Unsupported deployment config schema version '$($config.schemaVersion)'."
    }

    $simpleValues = @(
        [string]$config.gcpProject,
        [string]$config.instance,
        [string]$config.zone,
        [string]$config.machineType,
        [string]$config.sshUser
    )
    foreach ($value in $simpleValues) {
        if ($value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
            throw "Deployment config contains an unsafe identifier '$value'."
        }
    }

    $parsedAddress = $null
    if (-not [Net.IPAddress]::TryParse([string]$config.expectedExternalIp, [ref]$parsedAddress)) {
        throw "Deployment config contains invalid expectedExternalIp '$($config.expectedExternalIp)'."
    }

    if ([string]$config.publicHost -notmatch '^[A-Za-z0-9.-]+$') {
        throw "Deployment config contains invalid publicHost '$($config.publicHost)'."
    }

    if ([string]$config.adminCheckout -notmatch '^/[A-Za-z0-9._/-]+$') {
        throw "Deployment config contains invalid adminCheckout '$($config.adminCheckout)'."
    }

    if ([string]$config.originUrl -notmatch '^https://github\.com/[A-Za-z0-9._/-]+\.git$') {
        throw "Deployment config contains invalid originUrl '$($config.originUrl)'."
    }

    return $config
}

function Resolve-LudoraComponent {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Auto', 'Ui', 'Service', 'Discovery', 'Full')]
        [string]$RequestedComponent,

        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [string[]]$ChangedPaths,

        [Parameter(Mandatory = $true)]
        [bool]$AlreadyAtCommit,

        [bool]$LastSuccessfulCommitMatches = $false,

        [bool]$HasValidChangeBase = $true
    )

    if ($AlreadyAtCommit -and $LastSuccessfulCommitMatches -and $RequestedComponent -eq 'Auto') {
        return 'Verify'
    }

    if (-not $HasValidChangeBase -and $RequestedComponent -eq 'Auto') {
        return 'Full'
    }

    $hasUi = $false
    $hasService = $false
    $hasDiscovery = $false
    $hasUnknownRuntime = $false

    foreach ($path in $ChangedPaths) {
        $normalizedPath = $path.Replace('\', '/')
        if ($normalizedPath.StartsWith('ludora-admin-ui/')) {
            $hasUi = $true
        }
        elseif ($normalizedPath.StartsWith('ludora-admin-service/')) {
            $hasService = $true
        }
        elseif ($normalizedPath.StartsWith('ludora-discovery/')) {
            $hasDiscovery = $true
        }
        elseif (
            $normalizedPath.StartsWith('docs/') -or
            $normalizedPath.StartsWith('ops/') -or
            $normalizedPath.StartsWith('chrome-extension/') -or
            $normalizedPath.StartsWith('database/') -or
            $normalizedPath -in @('AGENTS.md', 'README.md', '.gitattributes', '.gitignore')
        ) {
            continue
        }
        else {
            $hasUnknownRuntime = $true
        }
    }

    if ($RequestedComponent -ne 'Auto') {
        if ($RequestedComponent -ne 'Full' -and $hasUnknownRuntime) {
            throw "Component $RequestedComponent is narrower than unclassified runtime changes."
        }
        if ($RequestedComponent -eq 'Ui' -and ($hasService -or $hasDiscovery)) {
            throw 'Component Ui is narrower than the detected service/discovery changes.'
        }
        if ($RequestedComponent -eq 'Service' -and ($hasUi -or $hasDiscovery)) {
            throw 'Component Service is narrower than the detected UI/discovery changes.'
        }
        if ($RequestedComponent -eq 'Discovery' -and ($hasUi -or $hasService)) {
            throw 'Component Discovery is narrower than the detected UI/service changes.'
        }
        return $RequestedComponent
    }

    if ($hasUnknownRuntime) {
        return 'Full'
    }

    $changedComponentCount = @(@($hasUi, $hasService, $hasDiscovery) | Where-Object { $_ }).Count
    if ($changedComponentCount -gt 1) {
        return 'Full'
    }
    if ($hasUi) {
        return 'Ui'
    }
    if ($hasService) {
        return 'Service'
    }
    if ($hasDiscovery) {
        return 'Discovery'
    }

    return 'Verify'
}

function Invoke-LudoraNativeCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,

        [Parameter(Mandatory = $true)]
        [string]$Operation
    )

    # The caller's deployment -WhatIf must not suppress this function's private
    # stderr redirection and cleanup. Production mutation remains behind the
    # Invoke-LudoraAdminDeploy ShouldProcess boundary.
    $WhatIfPreference = $false
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = & $FilePath @ArgumentList 2> $stderrPath
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }

        $stderr = @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue | ForEach-Object { $_.ToString() })
        if ($exitCode -ne 0) {
            $renderedOutput = @(($output | ForEach-Object { $_.ToString() })) -join [Environment]::NewLine
            $renderedError = $stderr -join [Environment]::NewLine
            $failureDetails = @($renderedOutput, $renderedError) | Where-Object { $_ }
            throw "$Operation failed with exit code $exitCode.$([Environment]::NewLine)$($failureDetails -join [Environment]::NewLine)"
        }

        if ($stderr.Count -gt 0) {
            Write-Verbose ("$Operation wrote to stderr: " + ($stderr -join ' | '))
        }

        return @(($output | ForEach-Object { $_.ToString() }))
    }
    finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-LudoraGitCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryPath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,

        [Parameter(Mandatory = $true)]
        [string]$Operation
    )

    $arguments = @('-C', $RepositoryPath) + $ArgumentList
    $output = Invoke-LudoraNativeCapture -FilePath 'git' -ArgumentList $arguments -Operation $Operation
    return ($output -join "`n").Trim()
}

function New-LudoraRemoteCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RemoteScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedCommit,

        [Parameter(Mandatory = $true)]
        [ValidateSet('Auto', 'Ui', 'Service', 'Discovery', 'Full')]
        [string]$Component,

        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$AssetMarker,

        [Parameter(Mandatory = $true)]
        [psobject]$Config,

        [Parameter(Mandatory = $true)]
        [bool]$AllowDatabasePatchPresence,

        [Parameter(Mandatory = $true)]
        [bool]$InitializeDeploymentBaseline
    )

    $payload = (Get-Content -LiteralPath $RemoteScriptPath -Raw).Replace("`r", '')
    $payloadBase64 = ConvertTo-LudoraGzipBase64 -Value $payload
    $markerBase64 = ConvertTo-LudoraBase64 -Value $AssetMarker

    $arguments = @(
        '--expected-commit', (ConvertTo-LudoraBashLiteral -Value $ExpectedCommit),
        '--component', (ConvertTo-LudoraBashLiteral -Value $Component.ToLowerInvariant()),
        '--asset-marker-base64', (ConvertTo-LudoraBashLiteral -Value $markerBase64),
        '--admin-checkout', (ConvertTo-LudoraBashLiteral -Value ([string]$Config.adminCheckout)),
        '--origin-url', (ConvertTo-LudoraBashLiteral -Value ([string]$Config.originUrl)),
        '--public-host', (ConvertTo-LudoraBashLiteral -Value ([string]$Config.publicHost)),
        '--expected-user', (ConvertTo-LudoraBashLiteral -Value ([string]$Config.sshUser))
    )

    if ($AllowDatabasePatchPresence) {
        $arguments += '--allow-database-patch-presence'
    }
    if ($InitializeDeploymentBaseline) {
        $arguments += '--initialize-deployment-baseline'
    }

    $pipeline = "printf '%s' $(ConvertTo-LudoraBashLiteral -Value $payloadBase64) | base64 --decode | gzip --decompress | bash -s -- $($arguments -join ' ')"
    return "bash -o pipefail -c $(ConvertTo-LudoraBashLiteral -Value $pipeline)"
}

function Assert-LudoraRemoteDeployResult {
    param(
        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [string[]]$Output,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedCommit
    )

    $statusLines = @($Output | Where-Object { $_ -eq 'REMOTE_DEPLOY_STATUS=success' })
    $resultLines = @($Output | Where-Object { $_.StartsWith('REMOTE_DEPLOY_RESULT=') })
    if ($statusLines.Count -ne 1 -or $resultLines.Count -ne 1) {
        throw 'Remote deployment did not emit exactly one success status and result.'
    }

    try {
        $result = $resultLines[0].Substring('REMOTE_DEPLOY_RESULT='.Length) | ConvertFrom-Json
    }
    catch {
        throw "Remote deployment emitted invalid result JSON: $($_.Exception.Message)"
    }

    $requiredProperties = @('status', 'component', 'previousCommit', 'commit')
    foreach ($property in $requiredProperties) {
        if ($result.PSObject.Properties.Name -notcontains $property) {
            throw "Remote deployment result is missing '$property'."
        }
    }

    if ([string]$result.status -ne 'success') {
        throw "Remote deployment result has unexpected status '$($result.status)'."
    }
    if ([string]$result.commit -ne $ExpectedCommit) {
        throw "Remote deployment reported commit '$($result.commit)', expected '$ExpectedCommit'."
    }
    if ([string]$result.component -notin @('Verify', 'Ui', 'Service', 'Discovery', 'Full')) {
        throw "Remote deployment reported invalid component '$($result.component)'."
    }

    return $result
}

function Test-LudoraExternalPortBlocked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,

        [Parameter(Mandatory = $true)]
        [int]$Port,

        [int]$TimeoutMilliseconds = 5000
    )

    $client = New-Object Net.Sockets.TcpClient
    try {
        $connectTask = $client.ConnectAsync($Address, $Port)
        $reachable = $false
        try {
            $reachable = $connectTask.Wait($TimeoutMilliseconds) -and $client.Connected
        }
        catch [AggregateException] {
            $reachable = $false
        }
        if ($reachable) {
            throw "Production port $Port is reachable externally at $Address."
        }
        Write-Output "EXTERNAL_PORT_${Port}=blocked"
    }
    finally {
        $client.Dispose()
    }
}

function Test-LudoraExternalControlPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,

        [int]$Port = 443,

        [int]$TimeoutMilliseconds = 5000
    )

    $client = New-Object Net.Sockets.TcpClient
    try {
        $connectTask = $client.ConnectAsync($Address, $Port)
        $reachable = $false
        try {
            $reachable = $connectTask.Wait($TimeoutMilliseconds) -and $client.Connected
        }
        catch [AggregateException] {
            $reachable = $false
        }
        if (-not $reachable) {
            throw "Cannot reach control port $Port at $Address, so workstation-side private-port checks would be inconclusive."
        }
        Write-Output "EXTERNAL_PORT_${Port}=reachable_control"
    }
    finally {
        $client.Dispose()
    }
}

function Invoke-LudoraAdminDeploy {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCommit,

        [ValidateSet('Auto', 'Ui', 'Service', 'Discovery', 'Full')]
        [string]$Component = 'Auto',

        [ValidateLength(0, 256)]
        [string]$AssetMarker = '',

        [switch]$AllowDatabasePatchPresence,

        [switch]$InitializeDeploymentBaseline,

        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    if ($AssetMarker -match '[\r\n]') {
        throw 'AssetMarker must be a single line.'
    }

    $ExpectedCommit = Assert-LudoraFullCommit -Commit $ExpectedCommit
    $config = Read-LudoraDeployConfig -ConfigPath $ConfigPath
    $opsPath = $script:LudoraDeployModuleRoot
    $canonicalConfigPath = (Resolve-Path -LiteralPath (Join-Path $opsPath 'admin-production.json')).Path
    $resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
    if (-not [string]::Equals($canonicalConfigPath, $resolvedConfigPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Only the repository-pinned admin-production.json config may be used.'
    }
    $repositoryPath = (Resolve-Path -LiteralPath (Split-Path -Parent $opsPath)).Path
    $remoteScriptPath = Join-Path $opsPath 'deploy-admin-remote.sh'

    Get-Command git -ErrorAction Stop | Out-Null
    $repositoryTopLevel = Invoke-LudoraGitCapture -RepositoryPath $repositoryPath -ArgumentList @('rev-parse', '--show-toplevel') -Operation 'Resolve repository root'
    if (-not [string]::Equals((Resolve-Path -LiteralPath $repositoryTopLevel).Path, $repositoryPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Deploy script resolved unexpected repository root '$repositoryTopLevel'."
    }

    $branch = Invoke-LudoraGitCapture -RepositoryPath $repositoryPath -ArgumentList @('branch', '--show-current') -Operation 'Read local branch'
    if ($branch -ne 'main') {
        throw "Local repository must be on main; current branch is '$branch'."
    }

    $localStatus = Invoke-LudoraGitCapture -RepositoryPath $repositoryPath -ArgumentList @('status', '--porcelain') -Operation 'Check local worktree'
    if ($localStatus) {
        throw "Local repository must be clean before deployment.$([Environment]::NewLine)$localStatus"
    }

    $localCommit = Invoke-LudoraGitCapture -RepositoryPath $repositoryPath -ArgumentList @('rev-parse', '--verify', "$ExpectedCommit^{commit}") -Operation 'Resolve expected commit'
    if ($localCommit -ne $ExpectedCommit) {
        throw "Expected commit '$ExpectedCommit' does not resolve exactly in the local repository."
    }

    $headCommit = Invoke-LudoraGitCapture -RepositoryPath $repositoryPath -ArgumentList @('rev-parse', 'HEAD') -Operation 'Read local HEAD'
    if ($headCommit -ne $ExpectedCommit) {
        throw "Expected commit '$ExpectedCommit' must equal local HEAD '$headCommit'."
    }

    $plan = [ordered]@{
        status = 'planned'
        component = $Component
        expectedCommit = $ExpectedCommit
        repository = $repositoryPath
        target = "$($config.sshUser)@$($config.instance)"
        project = $config.gcpProject
        zone = $config.zone
        publicHost = $config.publicHost
        allowsDatabasePatchPresence = [bool]$AllowDatabasePatchPresence
        initializesDeploymentBaseline = [bool]$InitializeDeploymentBaseline
    }
    Write-Output ('DEPLOY_PLAN=' + ($plan | ConvertTo-Json -Compress))

    $operationDescription = "deploy exact commit $ExpectedCommit with component mode $Component"
    if (-not $PSCmdlet.ShouldProcess("$($config.instance) in $($config.zone)", $operationDescription)) {
        Write-Output 'DEPLOY_STATUS=not_started'
        return
    }

    $remoteHeadOutput = Invoke-LudoraNativeCapture -FilePath 'git' -ArgumentList @('-C', $repositoryPath, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main') -Operation 'Read origin/main'
    $remoteHeadLine = ($remoteHeadOutput -join "`n").Trim()
    $remoteHead = ($remoteHeadLine -split '\s+')[0].ToLowerInvariant()
    if ($remoteHead -ne $ExpectedCommit) {
        throw "Expected commit '$ExpectedCommit' is not the current origin/main '$remoteHead'. Push it before deploying."
    }

    $gcloudCommand = Get-Command gcloud -ErrorAction Stop
    $instanceArguments = @(
        'compute', 'instances', 'describe', [string]$config.instance,
        '--project', [string]$config.gcpProject,
        '--zone', [string]$config.zone,
        '--format=json(name,zone,status,machineType,networkInterfaces)'
    )
    $instanceOutput = Invoke-LudoraNativeCapture -FilePath $gcloudCommand.Source -ArgumentList $instanceArguments -Operation 'Describe production VM'
    $instance = (($instanceOutput -join "`n") | ConvertFrom-Json)
    $actualZone = ([string]$instance.zone -replace '^.*/', '')
    $actualMachineType = ([string]$instance.machineType -replace '^.*/', '')
    $liveExternalIp = [string]$instance.networkInterfaces[0].accessConfigs[0].natIP

    if ([string]$instance.name -ne [string]$config.instance -or $actualZone -ne [string]$config.zone) {
        throw "gcloud returned unexpected VM identity '$($instance.name)' in '$actualZone'."
    }
    if ([string]$instance.status -ne 'RUNNING') {
        throw "Production VM is '$($instance.status)', not RUNNING."
    }
    if ($actualMachineType -ne [string]$config.machineType) {
        throw "Production VM machine type '$actualMachineType' does not match '$($config.machineType)'."
    }
    if ($liveExternalIp -ne [string]$config.expectedExternalIp) {
        throw "Live external IP '$liveExternalIp' does not match pinned IP '$($config.expectedExternalIp)'. Update DNS/config only after verification."
    }

    $dnsAddresses = @(
        Resolve-DnsName -Name ([string]$config.publicHost) -Type A -ErrorAction Stop |
            ForEach-Object {
                $addressProperty = $_.PSObject.Properties['IPAddress']
                if ($null -ne $addressProperty -and $addressProperty.Value) {
                    [string]$addressProperty.Value
                }
            } |
            Select-Object -Unique
    )
    if ($dnsAddresses -notcontains $liveExternalIp) {
        throw "DNS for '$($config.publicHost)' does not resolve to live VM IP '$liveExternalIp'."
    }

    $remoteCommand = New-LudoraRemoteCommand `
        -RemoteScriptPath $remoteScriptPath `
        -ExpectedCommit $ExpectedCommit `
        -Component $Component `
        -AssetMarker $AssetMarker `
        -Config $config `
        -AllowDatabasePatchPresence ([bool]$AllowDatabasePatchPresence) `
        -InitializeDeploymentBaseline ([bool]$InitializeDeploymentBaseline)

    $sshTarget = "$($config.sshUser)@$($config.instance)"
    $sshArguments = @(
        'compute', 'ssh', $sshTarget,
        '--project', [string]$config.gcpProject,
        '--zone', [string]$config.zone,
        "--command=$remoteCommand"
    )
    $remoteOutput = @(Invoke-LudoraNativeCapture -FilePath $gcloudCommand.Source -ArgumentList $sshArguments -Operation 'Remote Ludora admin deployment')
    $remoteResult = Assert-LudoraRemoteDeployResult -Output $remoteOutput -ExpectedCommit $ExpectedCommit
    $remoteOutput | Write-Output

    Test-LudoraExternalControlPort -Address $liveExternalIp -Port 443
    Test-LudoraExternalPortBlocked -Address $liveExternalIp -Port 3001
    Test-LudoraExternalPortBlocked -Address $liveExternalIp -Port 4001

    Write-Output 'DEPLOY_STATUS=success'
    $summary = [ordered]@{
        status = 'success'
        requestedComponent = $Component
        resolvedComponent = [string]$remoteResult.component
        expectedCommit = $ExpectedCommit
        instance = $config.instance
        zone = $config.zone
        externalIp = $liveExternalIp
        publicUrl = "https://$($config.publicHost)"
    }
    Write-Output ('DEPLOY_RESULT=' + ($summary | ConvertTo-Json -Compress))
}

Export-ModuleMember -Function Invoke-LudoraAdminDeploy
