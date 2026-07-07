param(
    [string]$SshHost = "diva-sbc",
    [int]$LocalApiPort = 15000,
    [int]$RemoteApiPort = 5000,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$sshConfig = Join-Path $env:USERPROFILE ".ssh\config"
$apiTarget = "http://127.0.0.1:$LocalApiPort"

Push-Location $repoRoot
try {
    Write-Host "[start-dev-sbc] Checking SSH config..."
    if (!(Test-Path $sshConfig)) {
        throw "SSH config not found: $sshConfig"
    }

    Write-Host "[start-dev-sbc] Checking SBC API tunnel on $apiTarget..."
    $tunnelOk = $false
    try {
        $health = Invoke-WebRequest -Uri "$apiTarget/api/health" -UseBasicParsing -TimeoutSec 2
        $tunnelOk = $health.StatusCode -eq 200
    } catch {
        $tunnelOk = $false
    }

    if (!$tunnelOk) {
        Write-Host "[start-dev-sbc] Starting SSH tunnel: localhost:$LocalApiPort -> ${SshHost}:localhost:$RemoteApiPort"
        Start-Process -FilePath "ssh.exe" `
            -ArgumentList @("-F", $sshConfig, "-N", "-L", "${LocalApiPort}:localhost:${RemoteApiPort}", $SshHost) `
            -WindowStyle Hidden

        Start-Sleep -Seconds 2
        $health = Invoke-WebRequest -Uri "$apiTarget/api/health" -UseBasicParsing -TimeoutSec 8
        if ($health.StatusCode -ne 200) {
            throw "SBC API tunnel did not return HTTP 200."
        }
    }

    Write-Host "[start-dev-sbc] SBC API tunnel is ready: $apiTarget"
    if ($CheckOnly) {
        return
    }

    $env:VITE_API_TARGET = $apiTarget
    Write-Host "[start-dev-sbc] Starting Vite with VITE_API_TARGET=$env:VITE_API_TARGET"
    npm run dev
}
finally {
    Pop-Location
}
