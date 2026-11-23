#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Executable,
    [ValidateRange(1, 100)][int] $Cycles = 10,
    [string] $FixtureDirectory,
    [string] $ReuseEvidence,
    [switch] $KnownManagedStartupBlock
)

$ErrorActionPreference = 'Stop'
$validation = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\validation\round4'
$runRoot = Join-Path $validation ('integration-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$rawRoot = Join-Path $runRoot 'lifecycle'
Write-Output "Integration evidence directory: $runRoot"

function Get-AsarMembers([string] $Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        try {
            if ($reader.ReadUInt32() -ne 4) { throw 'Invalid application ASAR size header.' }
            $headerSize = $reader.ReadUInt32()
            if ($headerSize -lt 8 -or $headerSize -gt 16MB -or $headerSize -gt ($stream.Length - 8)) {
                throw 'Invalid application ASAR header size.'
            }
            $payloadSize = $reader.ReadUInt32()
            $jsonSize = $reader.ReadUInt32()
            if ($payloadSize -ne ($headerSize - 4) -or $jsonSize -gt ($headerSize - 8)) {
                throw 'Invalid application ASAR JSON size.'
            }
            $header = ConvertFrom-Json -AsHashtable -InputObject ([Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$jsonSize)))
            return $header.files
        } finally {
            $reader.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

$statuses = @('PASS', 'FAIL', 'PARTIAL', 'NOT RUN', 'ENVIRONMENT_BLOCKED')
$checks = [ordered]@{
    'lifecycle' = 'Windows lifecycle and process ownership'
    'autologin' = 'Renderer auto-login and protected API'
    'anonymous-access' = 'Anonymous localhost request denied'
    'rsc' = 'React Server Components'
    'bundled-range' = 'Packaged Range request'
    'blob-worker' = 'Chromium Blob Worker'
    'persistent-profile' = 'Chromium profile across restart'
    'credential-canary' = 'Cookie and admission credential containment'
    'native-fullscreen' = 'Native display fullscreen and restoration'
    'native-fullscreen-windowed-escape' = 'Windowed native fullscreen and Escape'
    'native-fullscreen-maximized-button' = 'Maximized native fullscreen and player exit'
    'native-fullscreen-second-display' = 'Native fullscreen on a second display'
    'preset-initial' = 'First-launch desktop VOD presets'
    'preset-restart' = 'Desktop VOD preset edits persist across restart'
    'source-import' = 'VOD source import'
    'vod-search' = 'Synthetic VOD search and detail'
    'media-playback' = 'Authorized media playback'
    'native-download' = 'Native download with size and SHA-256'
    'business-persistence' = 'Business data and task recovery across restart'
    'main-resources' = 'Windows Main startup time, CPU and working set'
    'main-response' = 'Authenticated request timing and Main event loop'
    'long-playback-downloads' = 'Long playback with concurrent downloads'
    'protected-install' = 'Non-admin runtime in protected installation'
    'filesystem-matrix' = 'Final file commit and recovery by filesystem'
    'docker-runtime' = 'Docker container runtime'
}
$results = [ordered]@{}
foreach ($name in $checks.Keys) {
    $results[$name] = [pscustomobject]@{ Check = $name; Status = 'NOT RUN'; Observation = 'No execution evidence.' }
}
function Set-Check([string] $Name, [string] $Status, [string] $Observation) {
    if ($results.Contains($Name) -and $statuses -ccontains $Status) {
        $results[$Name] = [pscustomobject]@{ Check = $Name; Status = $Status; Observation = $Observation }
    }
}

$candidate = [ordered]@{
    Executable = $Executable; Sha256 = $null; AppAsarSha256 = $null; Commit = $null
    BuildId = $null; Electron = $null; Next = $null; RequestedCycles = $Cycles
    Windows = [Environment]::OSVersion.VersionString; PowerShell = $PSVersionTable.PSVersion.ToString()
    Mode = if ($ReuseEvidence) { 'reuse-existing-evidence' } else { 'execute-packaged-app' }
    RuntimeProbe = $null; RendererProbe = $null; LifecycleExitCode = $null
}
$rawRows = @()
$resourceRows = @()
$integrationRows = [Collections.Generic.List[object]]::new()
$eventSamples = [Collections.Generic.List[object]]::new()
$setupError = $null
try {
    $exe = (Get-Item -LiteralPath $Executable).FullName
    $candidate.Executable = $exe
    $candidate.Sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $resources = Join-Path (Split-Path -Parent $exe) 'resources'
    $asar = Join-Path $resources 'app.asar'
    $candidate.AppAsarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant()
    $members = Get-AsarMembers $asar
    if ($null -eq $members -or !$members.Contains('main.cjs')) { throw 'The selected executable is missing the LibreTV Main application.' }
    $candidate.RendererProbe = $members.Contains('renderer-acceptance.cjs')
    $candidate.RuntimeProbe = $members.Contains('integration-acceptance.cjs')
    $hasLifecycle = $members.Contains('smoke-control.cjs')
    if (!$candidate.RuntimeProbe) {
        foreach ($name in @('credential-canary', 'native-fullscreen', 'preset-initial', 'preset-restart', 'source-import', 'vod-search', 'media-playback', 'native-download', 'business-persistence', 'main-response')) {
            Set-Check $name 'NOT RUN' 'The selected package does not contain the dedicated integration probe.'
        }
    }
    $buildStamp = Join-Path $resources 'libretv-runtime\desktop-build.json'
    if (Test-Path -LiteralPath $buildStamp -PathType Leaf) {
        $build = Get-Content -LiteralPath $buildStamp -Raw | ConvertFrom-Json
        $candidate.Commit = $build.commit
        $candidate.BuildId = $build.buildId
        $candidate.Electron = $build.electron
        $candidate.Next = $build.next
    }

    if ($ReuseEvidence) {
        $rawRoot = (Get-Item -LiteralPath $ReuseEvidence).FullName
        $identity = Get-Content -LiteralPath (Join-Path $rawRoot 'run.json') -Raw | ConvertFrom-Json
        if ($identity.Sha256 -ne $candidate.Sha256 -or
            ($identity.AppAsarSha256 -and $identity.AppAsarSha256 -ne $candidate.AppAsarSha256) -or
            (!$identity.AppAsarSha256 -and $identity.Executable -ne $exe)) {
            throw 'Recorded lifecycle evidence belongs to a different application.'
        }
    } else {
        $flags = @('-Executable', $exe, '-Cycles', $Cycles, '-EvidenceDirectory', $rawRoot)
        if (!$hasLifecycle) { $flags += '-LegacyStartupOnly' }
        if ($candidate.RendererProbe -and $hasLifecycle) { $flags += '-RequireRendererChecks' }
        if ($candidate.RuntimeProbe -and $hasLifecycle) {
            $flags += '-RunIntegrationChecks'
            if ($FixtureDirectory) { $flags += @('-FixtureDirectory', $FixtureDirectory) }
        }
        $pwsh = Join-Path $PSHOME 'pwsh.exe'
        $PSNativeCommandUseErrorActionPreference = $false
        & $pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'test-packaged.ps1') @flags 2>&1 |
            Tee-Object -FilePath (Join-Path $runRoot 'lifecycle.log')
        $candidate.LifecycleExitCode = $LASTEXITCODE
    }

    $rawRows = @(Import-Csv -LiteralPath (Join-Path $rawRoot 'startup-shutdown.csv'))
    $failures = @($rawRows | Where-Object Status -eq 'FAIL')
    $blocked = @($rawRows | Where-Object Status -eq 'ENVIRONMENT_BLOCKED')
    $normal = @($rawRows | Where-Object { $_.Case -match '^normal-\d+$' -and $_.Status -eq 'PASS' })
    $needs = @('second-instance', 'port-conflict', 'force-kill-restart', 'missing-runtime-config')
    $verified = @($rawRows | Where-Object { $_.Case -in $needs -and $_.Status -eq 'PASS' })
    $failedLifecycle = @($failures | Where-Object Case -notin @('renderer-compatibility', 'packaged-integration'))
    if ($failedLifecycle.Count) {
        $earlyBreakpoint = @($failedLifecycle | Where-Object Observed -Match '0x80000003\) before ready\. Events:\s*$')
        if ($KnownManagedStartupBlock -and $earlyBreakpoint.Count -eq $failedLifecycle.Count) {
            Set-Check lifecycle ENVIRONMENT_BLOCKED 'Known managed-environment breakpoint before any Main log. The original launch remains FAIL in lifecycle CSV.'
        } else {
            Set-Check lifecycle FAIL ($failedLifecycle.Case -join ', ')
        }
    } elseif ($blocked.Count) {
        Set-Check lifecycle ENVIRONMENT_BLOCKED ($blocked.Case -join ', ')
    } elseif ($normal.Count -eq $Cycles -and $verified.Count -eq $needs.Count) {
        Set-Check lifecycle PASS "$Cycles normal cycles and four lifecycle fault cases passed."
    } elseif ($normal.Count -or @($rawRows | Where-Object Status -eq 'PASS').Count) {
        Set-Check lifecycle PARTIAL 'Lifecycle evidence did not cover all required cases.'
    }
    if ($normal.Count) { Set-Check anonymous-access PASS 'The external Windows HTTP client received 403 from the authenticated running app.' }
    elseif ($rawRows.Observed -contains 'External caller received a non-403 status') {
        Set-Check anonymous-access FAIL 'The anonymous client received an unexpected status.'
    }

    $profiles = Join-Path $rawRoot 'LibreTVDesktop-smoke'
    if (Test-Path -LiteralPath $profiles -PathType Container) {
        foreach ($profile in (Get-ChildItem -LiteralPath $profiles -Directory -Attributes '!ReparsePoint')) {
            if ($profile.Name -cnotmatch '^[a-f0-9]{32}$') { continue }
            foreach ($log in (Get-ChildItem -LiteralPath $profile.FullName -File -Filter 'startup-*.jsonl' -Attributes '!ReparsePoint')) {
                foreach ($line in (Get-Content -LiteralPath $log.FullName -Encoding UTF8)) {
                    try { $eventSamples.Add((ConvertFrom-Json -InputObject $line -ErrorAction Stop)) } catch { }
                }
            }
        }
    }
    $authenticated = @($eventSamples | Where-Object stage -eq 'smoke-renderer')
    $badAuth = @($authenticated | Where-Object {
        $_.status -ne 200 -or $_.auth -ne 200 -or $_.verified -ne $true -or $_.authVerified -ne $true -or
        $_.secured -ne 400 -or $_.passwordRequired -ne $true -or $_.search -ne 400
    })
    if ($hasLifecycle -and $badAuth.Count) { Set-Check autologin FAIL 'An observed Renderer auth or protected API reply failed its expected checks.' }
    elseif ($hasLifecycle -and $authenticated.Count) { Set-Check autologin PASS "$($authenticated.Count) authenticated renderer observations." }

    $compatibility = @($eventSamples | Where-Object stage -eq 'renderer-acceptance')
    foreach ($name in @('rsc', 'bundled-range', 'blob-worker')) {
        $observed = @($compatibility.checks | Where-Object name -eq $name)
        if (@($observed | Where-Object passed -ne $true).Count) { Set-Check $name FAIL 'A recorded Chromium compatibility check failed.' }
        elseif ($observed.Count) { Set-Check $name PASS "$($observed.Count) actual Chromium observations." }
    }
    if (@($rawRows | Where-Object { $_.Case -eq 'renderer-compatibility' -and $_.Status -eq 'PASS' }).Count) {
        Set-Check persistent-profile PASS 'A profile marker survived an orderly shutdown and relaunch.'
    } elseif (@($rawRows | Where-Object Observed -Match 'lost its renderer storage marker').Count) {
        Set-Check persistent-profile FAIL 'The renderer marker did not survive relaunch.'
    }

    $probeEvents = if ($candidate.RuntimeProbe) { $eventSamples | Where-Object stage -eq 'integration-check' }
    foreach ($observation in $probeEvents) {
        $name = [string]$observation.name
        $status = [string]$observation.status
        if (!$results.Contains($name) -or $statuses -cnotcontains $status) { continue }
        $code = [string]$observation.code
        if ($code -cnotmatch '^[A-Za-z0-9_-]{1,80}$') { $code = $null }
        $metrics = [ordered]@{}
        foreach ($property in $observation.metrics.PSObject.Properties) {
            if ($property.Name -cmatch '^[A-Za-z][A-Za-z0-9_]{0,79}$' -and
                $property.Value -is [ValueType] -and $property.Value -isnot [DateTime]) {
                $metrics[$property.Name] = $property.Value
            }
        }
        $integrationRows.Add([pscustomobject]@{ Check = $name; Status = $status; Code = $code; Metrics = $metrics })
        if ($results[$name].Status -eq 'FAIL' -or ($status -eq 'NOT RUN' -and $results[$name].Status -ne 'NOT RUN')) { continue }
        Set-Check $name $status 'Recorded by the packaged integration probe.'
    }

    $fullscreenChecks = @('native-fullscreen-windowed-escape', 'native-fullscreen-maximized-button', 'native-fullscreen-second-display')
    $fullscreenStates = $fullscreenChecks | ForEach-Object { $results[$_].Status }
    if ($fullscreenStates -contains 'FAIL') {
        Set-Check native-fullscreen FAIL 'An observed fullscreen scenario failed.'
    } elseif (@($fullscreenStates | Where-Object { $_ -eq 'PASS' }).Count -eq $fullscreenChecks.Count) {
        Set-Check native-fullscreen PASS 'Windowed, maximized and second-display cases passed.'
    } elseif ($fullscreenStates -contains 'PASS' -or $fullscreenStates -contains 'PARTIAL') {
        Set-Check native-fullscreen PARTIAL 'Some fullscreen scenarios passed or were partly exercised.'
    } elseif ($fullscreenStates -contains 'ENVIRONMENT_BLOCKED') {
        Set-Check native-fullscreen ENVIRONMENT_BLOCKED 'The available Windows desktop environment blocked fullscreen verification.'
    }

    $samplesPath = Join-Path $rawRoot 'main-resources.csv'
    if ((Test-Path -LiteralPath $samplesPath -PathType Leaf) -and (Get-Item -LiteralPath $samplesPath).Length -gt 0) {
        $resourceRows = @(Import-Csv -LiteralPath $samplesPath | Where-Object Status -eq 'PASS')
        if ($resourceRows.Count) { Set-Check main-resources PASS "$($resourceRows.Count) actual process samples. Warm mixed workload is tracked separately." }
    }
} catch {
    $setupError = $_.Exception.Message
    Set-Check lifecycle FAIL 'The validation controller could not complete. See run.json.'
} finally {
    $report = [ordered]@{
        Candidate = $candidate; RawEvidence = $rawRoot; SetupError = $setupError
        Results = @($results.Values); RawLifecycle = $rawRows; NativeProcessSamples = $resourceRows
        IntegrationProbeSamples = @($integrationRows.ToArray())
    }
    $report | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath (Join-Path $runRoot 'run.json') -Encoding utf8NoBOM
    $reportLines = @(
        '# LibreTV Desktop Windows integration', '',
        "| Build identity | Value |", '| --- | --- |',
        "| EXE SHA-256 | $($candidate.Sha256) |", "| ASAR SHA-256 | $($candidate.AppAsarSha256) |",
        "| Commit | $($candidate.Commit) |", "| Next.js build ID | $($candidate.BuildId) |",
        "| Mode | $($candidate.Mode) |", '',
        '| Check | Status | Observation |', '| --- | --- | --- |'
    )
    foreach ($item in $results.Values) { $reportLines += "| $($checks[$item.Check]) | $($item.Status) | $($item.Observation) |" }
    $reportLines | Set-Content -LiteralPath (Join-Path $runRoot 'acceptance.md') -Encoding utf8NoBOM
    $index = @(
        '# Evidence index', '', '- acceptance.md — integration status by scope.',
        '- run.json — executable identity, raw lifecycle cases and Main resource samples.',
        "- Lifecycle evidence directory — $rawRoot",
        '- startup-shutdown.csv — individual exit, port and restart results when the launcher ran.',
        '- process-tree.csv — observed Windows process trees when available.',
        '- main-resources.csv — sampled Main ready time, CPU and working set when available.',
        '- LibreTVDesktop-smoke — isolated profile records and application startup diagnostics.'
    )
    if (!$ReuseEvidence) { $index += '- lifecycle.log — lifecycle runner output.' }
    $index | Set-Content -LiteralPath (Join-Path $runRoot 'index.md') -Encoding utf8NoBOM
    Write-Output "Integration report: $(Join-Path $runRoot 'acceptance.md')"
}

$required = @($results.Values | Where-Object Check -notin @('long-playback-downloads', 'protected-install', 'filesystem-matrix', 'docker-runtime'))
if ($required.Status -contains 'FAIL' -or @($rawRows | Where-Object { $_.Case -in @('renderer-compatibility', 'packaged-integration') -and $_.Status -eq 'FAIL' }).Count) { exit 1 }
if (@($required | Where-Object Status -ne 'PASS').Count) { exit 2 }
exit 0
