#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Executable,
    [ValidateRange(1, 100)][int] $Cycles = 10
)

$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath $Executable).FullName
$validation = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\validation'
$runRoot = Join-Path $validation ('p1-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
Write-Output "Smoke evidence directory: $runRoot"

$processes = [Collections.Generic.List[System.Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()
$snapshots = [Collections.Generic.List[object]]::new()
$case = 'setup'

function Assert-Observed([bool] $Passed, [string] $Message) {
    if (!$Passed) { throw $Message }
}

function Get-Listeners {
    foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp)) {
        if ($line -match '^\s*TCP\s+(\S+):17888\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$') {
            [pscustomobject]@{ Address = $Matches[1]; Owner = [int]$Matches[2] }
        }
    }
}

function Get-Tree([int] $RootId) {
    $records = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name
    $members = [Collections.Generic.HashSet[int]]::new()
    $queue = [Collections.Generic.Queue[int]]::new()
    [void]$members.Add($RootId)
    $queue.Enqueue($RootId)
    while ($queue.Count) {
        $parent = $queue.Dequeue()
        foreach ($record in $records) {
            if ($record.ParentProcessId -eq $parent -and $members.Add([int]$record.ProcessId)) {
                $queue.Enqueue([int]$record.ProcessId)
            }
        }
    }
    $records | Where-Object { $members.Contains([int]$_.ProcessId) }
}

function Get-Events([string] $ProfileId, [int] $RootId) {
    $profilePath = Join-Path $runRoot "LibreTVDesktop-smoke\$ProfileId"
    if (!(Test-Path -LiteralPath $profilePath)) { return }
    $files = Get-ChildItem -LiteralPath $profilePath -Filter "startup-*-$RootId.jsonl" -File
    foreach ($file in $files) {
        foreach ($line in (Get-Content -LiteralPath $file.FullName -Encoding UTF8)) {
            try { ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch {
                # The last line may still be in the process of being appended.
            }
        }
    }
}

function Start-Smoke([string] $ProfileId, [string] $Binary = $exe, [switch] $Hold) {
    $arguments = @("--libretv-smoke=$ProfileId")
    if ($Hold) { $arguments += '--libretv-smoke-hold' }
    $process = Start-Process -FilePath $Binary -ArgumentList $arguments -WorkingDirectory $runRoot -WindowStyle Hidden -PassThru
    $processes.Add($process)
    return $process
}

function Wait-Smoke([System.Diagnostics.Process] $Process, [string] $ProfileId) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 30) {
        $events = @(Get-Events $ProfileId $Process.Id)
        if ($events.stage -contains 'smoke-ready') { return $events }
        if ($Process.HasExited) {
            throw "Smoke process $($Process.Id) exited with $($Process.ExitCode) before ready. Events: $($events.stage -join ', ')"
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Smoke process $($Process.Id) did not report ready within 30 seconds."
}

function Assert-Running([System.Diagnostics.Process] $Process, [object[]] $Events) {
    $listeners = @(Get-Listeners)
    Assert-Observed ($listeners.Count -eq 1 -and $listeners[0].Owner -eq $Process.Id -and $listeners[0].Address -eq '127.0.0.1') 'Fixed loopback listener is not owned solely by the Electron Main PID'
    $tree = @(Get-Tree $Process.Id)
    Assert-Observed ($tree.ProcessId -contains $Process.Id) 'Electron Main missing from Windows process tree'
    Assert-Observed (!($tree.Name -contains 'node.exe')) 'Unexpected external Node process'
    foreach ($item in $tree) {
        $snapshots.Add([pscustomobject]@{
            Case = $case; Main = $Process.Id; Pid = $item.ProcessId; Parent = $item.ParentProcessId; Name = $item.Name
        })
    }
    Assert-Observed ((@($Events | Where-Object stage -eq 'renderer-loaded').route -join ',') -eq '/,/live') 'Both packaged pages must load'
    $renderer = @($Events | Where-Object stage -eq 'smoke-renderer')
    Assert-Observed ($renderer.Count -eq 2 -and @($renderer | Where-Object {
        $_.status -eq 200 -and $_.auth -eq 200 -and $_.secured -eq 401 -and $_.isolated -and $_.scripts -gt 0 -and $_.stylesheets -gt 0
    }).Count -eq 2) 'Renderer API, auth or static asset check did not pass'
    $anonymous = Invoke-WebRequest -Uri 'http://127.0.0.1:17888/api/status' -NoProxy -TimeoutSec 2 -SkipHttpErrorCheck
    Assert-Observed ([int]$anonymous.StatusCode -eq 403) 'External caller received a non-403 status'
}

function Assert-Released([int] $MainId) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (@(Get-Listeners).Count -eq 0 -and @(Get-Tree $MainId).Count -eq 0) { return }
        Start-Sleep -Milliseconds 150
    } while ($clock.Elapsed.TotalSeconds -lt 10)
    throw "Listener or descendants of smoke process $MainId remained after exit."
}

function Assert-NormalExit([System.Diagnostics.Process] $Process, [string] $ProfileId) {
    Assert-Observed ($Process.WaitForExit(15000) -and $Process.ExitCode -eq 0) 'Normal close did not return exit 0'
    $events = @(Get-Events $ProfileId $Process.Id)
    Assert-Observed ($events.stage -notcontains 'shutdown-deadline' -and ($events | Where-Object stage -eq 'shutdown').listenerClosed -eq $true) 'Application did not report a graceful listener close'
    Assert-Released $Process.Id
}

function Record-Pass([int] $MainId, [string] $Observation) {
    $results.Add([pscustomobject]@{ Case = $case; MainPid = $MainId; Status = 'PASS'; Observed = $Observation })
    Write-Output "$case PASS ($Observation)"
}

$oldPath = $env:Path
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
try {
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:TEMP = $runRoot
    $env:TMP = $runRoot
    Assert-Observed (!(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) 'System Node still appears on the test PATH'
    Assert-Observed (@(Get-Listeners).Count -eq 0) 'Port 17888 is occupied before testing'

    foreach ($index in 1..$Cycles) {
        $case = "normal-$index"
        $id = [guid]::NewGuid().ToString('N')
        $main = Start-Smoke $id
        $events = Wait-Smoke $main $id
        Assert-Running $main $events
        Assert-NormalExit $main $id
        Record-Pass $main.Id 'Main owns 17888, renderer and API checks pass, port and children released'
    }

    $case = 'second-instance'
    $id = [guid]::NewGuid().ToString('N')
    $main = Start-Smoke $id
    $events = Wait-Smoke $main $id
    $second = Start-Smoke $id
    Assert-Observed ($second.WaitForExit(5000) -and $second.ExitCode -eq 0) 'Second launch did not exit cleanly'
    Assert-Running $main $events
    Assert-Observed ((@(Get-Events $id $main.Id).stage) -contains 'second-instance') 'Main did not receive second launch'
    Assert-NormalExit $main $id
    Record-Pass $main.Id 'Second launch signaled the existing app and never owned the listener'

    $case = 'port-conflict'
    $holder = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 17888)
    $holder.ExclusiveAddressUse = $true
    $holder.Start()
    try {
        $id = [guid]::NewGuid().ToString('N')
        $main = Start-Smoke $id
        Assert-Observed ($main.WaitForExit(12000) -and $main.ExitCode -eq 1) 'Occupied port did not fail startup'
        $events = @(Get-Events $id $main.Id)
        Assert-Observed (($events | Where-Object stage -eq 'boot-failed').code -eq 'EADDRINUSE') 'Expected the native port-conflict diagnostic'
        Assert-Observed ($events.stage -notcontains 'renderer-loaded' -and $events.stage -notcontains 'owned-listener') 'Startup proceeded without owning the listener'
        Assert-Observed (!$holder.Pending() -and @(Get-Listeners).Owner -eq $PID) 'The occupied listener received a connection or changed owners'
        Record-Pass $main.Id 'EADDRINUSE, zero connections to test listener, holder remains active'
    } finally {
        $holder.Stop()
    }

    $case = 'force-kill-restart'
    $id = [guid]::NewGuid().ToString('N')
    $main = Start-Smoke $id -Hold
    $events = Wait-Smoke $main $id
    Assert-Running $main $events
    $crashed = $main.Id
    $main.Kill()
    Assert-Observed ($main.WaitForExit(8000)) 'Force-killed Main did not exit'
    Assert-Released $crashed
    $main = Start-Smoke $id
    $events = Wait-Smoke $main $id
    Assert-Running $main $events
    Assert-NormalExit $main $id
    Record-Pass $main.Id "Force-stopped PID $crashed, released port/tree and relaunched with the same test profile"

    $case = 'missing-runtime-config'
    $broken = Join-Path $runRoot 'missing-config-fixture'
    Copy-Item -LiteralPath (Split-Path -Parent $exe) -Destination $broken -Recurse
    $copiedConfig = Join-Path $broken 'resources\libretv-runtime\next.config.js'
    Rename-Item -LiteralPath $copiedConfig -NewName 'next.config.js.omitted'
    $id = [guid]::NewGuid().ToString('N')
    $main = Start-Smoke $id -Binary (Join-Path $broken (Split-Path -Leaf $exe))
    Assert-Observed ($main.WaitForExit(10000) -and $main.ExitCode -eq 1) 'Missing runtime config did not fail startup'
    $events = @(Get-Events $id $main.Id)
    Assert-Observed (($events | Where-Object stage -eq 'boot-failed').code -eq 'RUNTIME_ASSETS' -and $events.stage -notcontains 'owned-listener') 'Missing configuration was not detected before serving'
    Assert-Released $main.Id
    Record-Pass $main.Id 'Missing JavaScript config detected before binding'
} catch {
    $results.Add([pscustomobject]@{ Case = $case; MainPid = $null; Status = 'FAIL'; Observed = $_.Exception.Message })
    throw
} finally {
    foreach ($process in $processes) {
        if (!$process.HasExited) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
        }
        $process.Dispose()
    }
    $results | Export-Csv -LiteralPath (Join-Path $runRoot 'startup-shutdown.csv') -NoTypeInformation -Encoding UTF8
    $snapshots | Export-Csv -LiteralPath (Join-Path $runRoot 'process-tree.csv') -NoTypeInformation -Encoding UTF8
    $env:Path = $oldPath
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
}
