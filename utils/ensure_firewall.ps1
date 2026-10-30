# CCTVGO: allow inbound connections to this install's go2rtc.exe (WebRTC video goes directly to viewers).
# Called by cctvgo.bat in the background after the service starts. Asks for admin rights (UAC) only when the rule is missing.
# If the user declines or anything fails, CCTVGO still runs (fewer networks can connect); the result is logged.
# After a decline (or a standard user who cannot approve), logs\firewall.declined is written and we do not ask
# again on every boot. Delete that file to be asked again.
# The rule name must match backend/diagnostics/environment.js firewallRuleName():
#   "CCTVGO go2rtc " + first 8 hex chars of SHA-1(lowercase install dir without trailing backslash)
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [switch]$CheckOnly,
    [switch]$NameOnly
)

# cctvgo.bat passes "%~dp0." (a trailing backslash before the closing quote would escape it); normalize it
$dir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
$sha1 = [System.Security.Cryptography.SHA1]::Create()
$hash = ($sha1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dir.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join ''
$ruleName = "CCTVGO go2rtc " + $hash.Substring(0, 8)
if ($NameOnly) { Write-Output $ruleName; exit 0 }

$exe = Join-Path $dir 'go2rtc\go2rtc.exe'
$logFile = Join-Path $LogDir 'firewall.log'
$declined = Join-Path $LogDir 'firewall.declined'
function Log($msg) {
    try {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        Add-Content -LiteralPath $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
    } catch { }
}
function RuleExists {
    & netsh advfirewall firewall show rule name="$ruleName" | Out-Null
    return ($LASTEXITCODE -eq 0)
}

if (RuleExists) { Log "rule present: $ruleName"; exit 0 }
if ($CheckOnly) { Log "rule missing (check only): $ruleName"; exit 1 }
if (Test-Path -LiteralPath $declined) { Log "rule missing, not asking again (declined before; delete firewall.declined to ask again)"; exit 1 }

$args = "advfirewall firewall add rule name=`"$ruleName`" dir=in action=allow program=`"$exe`" enable=yes profile=any"
try {
    Start-Process -FilePath netsh -ArgumentList $args -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop
} catch {
    Log "rule not added (declined or failed): $($_.Exception.Message)"
    try { Set-Content -LiteralPath $declined -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ASCII } catch { }
    exit 1
}
if (RuleExists) { Log "rule added: $ruleName"; exit 0 }
Log "rule not added (unknown reason): $ruleName"
exit 1
