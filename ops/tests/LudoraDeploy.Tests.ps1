$modulePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'LudoraDeploy.psm1'
Import-Module -Name $modulePath -Force

Describe 'Ludora deployment tooling' {
    InModuleScope LudoraDeploy {
        It 'requires a full commit SHA' {
            { Assert-LudoraFullCommit -Commit 'abc1234' } | Should Throw
            Assert-LudoraFullCommit -Commit ('A' * 40) | Should Be ('a' * 40)
        }

        It 'maps changed paths to the narrowest safe component' {
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-admin-ui/src/App.tsx') -AlreadyAtCommit $false | Should Be 'Ui'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-admin-service/src/server.ts') -AlreadyAtCommit $false | Should Be 'Service'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-discovery/src/ludora/api.py') -AlreadyAtCommit $false | Should Be 'Discovery'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-admin-ui/src/App.tsx', 'ludora-admin-service/src/server.ts') -AlreadyAtCommit $false | Should Be 'Full'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('docs/production-deployment.md') -AlreadyAtCommit $false | Should Be 'Verify'
        }

        It 'does not mistake HEAD equality for a completed deployment' {
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @() -AlreadyAtCommit $true -LastSuccessfulCommitMatches $true | Should Be 'Verify'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @() -AlreadyAtCommit $true -HasValidChangeBase $false | Should Be 'Full'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-admin-ui/src/App.tsx') -AlreadyAtCommit $true -HasValidChangeBase $true | Should Be 'Ui'
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('ludora-admin-ui/src/App.tsx') -AlreadyAtCommit $false -HasValidChangeBase $false | Should Be 'Full'
        }

        It 'treats unknown production paths conservatively' {
            Resolve-LudoraComponent -RequestedComponent Auto -ChangedPaths @('unexpected-runtime/config.json') -AlreadyAtCommit $false | Should Be 'Full'
            { Resolve-LudoraComponent -RequestedComponent Ui -ChangedPaths @('unexpected-runtime/config.json') -AlreadyAtCommit $false } | Should Throw
        }

        It 'rejects an explicitly narrow component' {
            { Resolve-LudoraComponent -RequestedComponent Ui -ChangedPaths @('ludora-admin-service/src/server.ts') -AlreadyAtCommit $false } | Should Throw
        }

        It 'round-trips marker text through UTF-8 base64' {
            $enye = [string][char]0x00F1
            $marker = "Ludora 'marker' `$value $enye"
            $encoded = ConvertTo-LudoraBase64 -Value $marker
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | Should Be $marker
        }

        It 'quotes apostrophes as one Bash argument' {
            $singleQuote = [string][char]39
            $doubleQuote = [string][char]34
            $expected = $singleQuote + 'a' + $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote + 'b' + $singleQuote
            ConvertTo-LudoraBashLiteral -Value "a'b" | Should Be $expected
        }

        It 'loads the pinned production config' {
            $config = Read-LudoraDeployConfig -ConfigPath (Join-Path $script:LudoraDeployModuleRoot 'admin-production.json')
            $config.instance | Should Be 'ludora-admin-img-20260714-105613'
            $config.zone | Should Be 'us-central1-a'
            $config.sshUser | Should Be 'robertorojas87'
        }

        It 'renders the remote payload as one line with safe encoded marker data' {
            $config = Read-LudoraDeployConfig -ConfigPath (Join-Path $script:LudoraDeployModuleRoot 'admin-production.json')
            $enye = [string][char]0x00F1
            $marker = "Ludora '$enye' `$marker"
            $command = New-LudoraRemoteCommand `
                -RemoteScriptPath (Join-Path $script:LudoraDeployModuleRoot 'deploy-admin-remote.sh') `
                -ExpectedCommit ('a' * 40) `
                -Component Auto `
                -AssetMarker $marker `
                -Config $config `
                -AllowDatabasePatchPresence $false `
                -InitializeDeploymentBaseline $false

            $command.Contains("`r") | Should Be $false
            $command.Contains("`n") | Should Be $false
            $command | Should Match '^bash -o pipefail -c '
            $command | Should Match 'base64 --decode \| gzip --decompress \| bash -s -- '
            $command.Contains((ConvertTo-LudoraBase64 -Value $marker)) | Should Be $true
        }

        It 'omits the optional marker argument when no marker is configured' {
            $config = Read-LudoraDeployConfig -ConfigPath (Join-Path $script:LudoraDeployModuleRoot 'admin-production.json')
            $command = New-LudoraRemoteCommand `
                -RemoteScriptPath (Join-Path $script:LudoraDeployModuleRoot 'deploy-admin-remote.sh') `
                -ExpectedCommit ('a' * 40) `
                -Component Auto `
                -AssetMarker '' `
                -Config $config `
                -AllowDatabasePatchPresence $false `
                -InitializeDeploymentBaseline $false

            $command | Should Not Match '--asset-marker-base64'
            $command | Should Match "--component .* --admin-checkout "
        }

        It 'requires one remote success result for the exact commit' {
            $commit = 'a' * 40
            $output = @(
                ''
                'DEPLOY_STEP=verify.record_success',
                'REMOTE_DEPLOY_STATUS=success',
                "REMOTE_DEPLOY_RESULT={`"status`":`"success`",`"component`":`"Ui`",`"previousCommit`":`"$commit`",`"commit`":`"$commit`"}"
            )

            $result = Assert-LudoraRemoteDeployResult -Output $output -ExpectedCommit $commit
            $result.component | Should Be 'Ui'
            { Assert-LudoraRemoteDeployResult -Output @('REMOTE_DEPLOY_STATUS=success') -ExpectedCommit $commit } | Should Throw
            { Assert-LudoraRemoteDeployResult -Output $output -ExpectedCommit ('b' * 40) } | Should Throw
        }

        It 'keeps native stderr separate from successful stdout on Windows PowerShell 5.1' {
            $output = Invoke-LudoraNativeCapture `
                -FilePath 'cmd.exe' `
                -ArgumentList @('/d', '/c', 'echo stdout-value & echo benign-warning 1>&2 & exit /b 0') `
                -Operation 'Native warning fixture'
            ($output -join "`n").Trim() | Should Be 'stdout-value'
        }

        It 'converts a native nonzero exit into an operation failure' {
            { Invoke-LudoraNativeCapture -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', 'echo failed 1>&2 & exit /b 7') -Operation 'Native failure fixture' } | Should Throw
        }
    }
}
