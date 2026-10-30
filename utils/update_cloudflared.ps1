param([string]$exe, [int]$timeoutSec = 60)

# Update cloudflared.exe in place with "cloudflared update".
# Any failure (no network, timeout, broken download) must not affect the tunnel:
# the original exe is backed up first and restored unless the new one runs.
# Always exits 0 so callers carry on as before.

function Write-UpdLog {
    param([string]$msg)
    Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [cloudflared-update] $msg"
}

# Runs the exe and returns its exit code, or $null if it did not finish in time
function Invoke-WithTimeout {
    param([string[]]$arguments, [int]$ms, [string]$stdoutPath)
    $opts = @{ FilePath = $exe; ArgumentList = $arguments; WindowStyle = 'Hidden'; PassThru = $true }
    if ($stdoutPath) { $opts.RedirectStandardOutput = $stdoutPath }
    $p = Start-Process @opts
    $null = $p.Handle  # keep the handle so ExitCode is available after exit
    if (-not $p.WaitForExit($ms)) {
        try { $p.Kill(); $null = $p.WaitForExit(5000) } catch {}
        return $null
    }
    return $p.ExitCode
}

function Test-Exe {
    $out = [System.IO.Path]::GetTempFileName()
    try {
        if (-not (Test-Path $exe)) { return $null }
        $code = Invoke-WithTimeout -arguments @('--version') -ms 15000 -stdoutPath $out
        $text = Get-Content $out -Raw -ErrorAction SilentlyContinue
        if ($code -eq 0 -and $text -match 'cloudflared version (\S+)') { return $Matches[1] }
        return $null
    } catch { return $null } finally { Remove-Item $out -Force -ErrorAction SilentlyContinue }
}

if (-not $exe -or -not (Test-Path $exe)) { Write-UpdLog "skip: not found [$exe]"; exit 0 }

$bak = "$exe.bak"
$old = "$exe.old"
try {
    $before = Test-Exe
    if (-not $before) { Write-UpdLog "skip: current exe does not run"; exit 0 }
    Remove-Item $old -Force -ErrorAction SilentlyContinue
    Copy-Item $exe $bak -Force -ErrorAction Stop

    $code = Invoke-WithTimeout -arguments @('update') -ms ($timeoutSec * 1000)

    $after = Test-Exe
    if (-not $after) {
        Copy-Item $bak $exe -Force -ErrorAction Stop
        Write-UpdLog "new exe does not run (exit=$code); restored $before"
    } elseif ($after -ne $before) {
        Write-UpdLog "updated $before -> $after"
    } elseif ($null -eq $code) {
        Write-UpdLog "timeout after ${timeoutSec}s; kept $after"
    } elseif ($code -eq 0) {
        Write-UpdLog "up to date $after"
    } else {
        Write-UpdLog "update failed (exit=$code); kept $after"
    }
} catch {
    Write-UpdLog "error: $($_.Exception.Message)"
    if ((Test-Path $bak) -and -not (Test-Exe)) {
        try { Copy-Item $bak $exe -Force -ErrorAction Stop; Write-UpdLog "restored from backup" } catch { Write-UpdLog "restore failed: $($_.Exception.Message)" }
    }
} finally {
    if (Test-Exe) {
        Remove-Item $bak -Force -ErrorAction SilentlyContinue
        Remove-Item $old -Force -ErrorAction SilentlyContinue
    }
    # partial download left behind when the update is cut off
    Remove-Item "$exe.new" -Force -ErrorAction SilentlyContinue
}
exit 0
