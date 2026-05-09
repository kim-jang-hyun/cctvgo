param([string]$heartbeatPath)

$logPath = if ($heartbeatPath) {
    [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($heartbeatPath), "nosleep.log")
} else { $null }

function Write-NSLog {
    param([string]$msg)
    if ($logPath) {
        try { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Out-File -FilePath $logPath -Append -Encoding UTF8 } catch {}
    }
}

Write-NSLog "Started. PID=$PID heartbeatPath=[$heartbeatPath]"

if ($heartbeatPath) {
    $hbDir = [System.IO.Path]::GetDirectoryName($heartbeatPath)
    if ($hbDir -and -not (Test-Path $hbDir)) {
        New-Item -ItemType Directory -Path $hbDir -Force | Out-Null
    }
    # PID 파일을 즉시 기록 (bat의 tasklist 체크용)
    $pidFile = [System.IO.Path]::ChangeExtension($heartbeatPath, ".pid")
    try {
        "$PID" | Out-File -FilePath $pidFile -Encoding ASCII -NoNewline -Force
        Write-NSLog "PID file written: $pidFile"
    } catch {
        Write-NSLog "PID file write failed: $_"
    }
}

try {
    & powercfg /change standby-timeout-ac 0 2>$null
    & powercfg /change standby-timeout-dc 0 2>$null
    & powercfg /change hibernate-timeout-ac 0 2>$null
    Write-NSLog "powercfg OK"
} catch {
    Write-NSLog "powercfg error: $_"
}

$hasSetTES = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PowerHelper {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
    $hasSetTES = $true
    Write-NSLog "Add-Type OK"
} catch {
    Write-NSLog "Add-Type failed (skipping): $_"
}

Write-NSLog "Entering heartbeat loop"

while ($true) {
    if ($hasSetTES) {
        try { [PowerHelper]::SetThreadExecutionState([uint32]2147483649) | Out-Null } catch {}
    }
    if ($heartbeatPath) {
        try {
            Set-Content -Path $heartbeatPath -Value "ok" -Force
        } catch {
            Write-NSLog "Heartbeat write failed: $_"
        }
    }
    Start-Sleep -Seconds 30
}
