[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$ExpectedCommit,

    [ValidateSet('Auto', 'Ui', 'Service', 'Discovery', 'Full')]
    [string]$Component = 'Auto',

    [ValidateLength(0, 256)]
    [string]$AssetMarker = '',

    [switch]$AllowDatabasePatchPresence,

    [switch]$InitializeDeploymentBaseline
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'LudoraDeploy.psm1'
Import-Module -Name $modulePath -Force

$invokeParameters = @{
    ExpectedCommit = $ExpectedCommit
    Component = $Component
    AssetMarker = $AssetMarker
    AllowDatabasePatchPresence = $AllowDatabasePatchPresence
    InitializeDeploymentBaseline = $InitializeDeploymentBaseline
    ConfigPath = (Join-Path $PSScriptRoot 'admin-production.json')
}

if ($WhatIfPreference) {
    $invokeParameters['WhatIf'] = $true
}

if ($PSBoundParameters.ContainsKey('Confirm')) {
    $invokeParameters['Confirm'] = $PSBoundParameters['Confirm']
}

try {
    Invoke-LudoraAdminDeploy @invokeParameters
}
catch {
    $errorSummary = [ordered]@{
        status = 'failed'
        message = ($_.Exception.Message -replace '[\r\n]+', ' | ')
    }
    Write-Output 'DEPLOY_STATUS=failed'
    Write-Output ('DEPLOY_ERROR=' + ($errorSummary | ConvertTo-Json -Compress))
    throw
}
