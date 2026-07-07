param(
    [string]$SshHost = "diva-sbc",
    [int]$RemoteWebPort = 8080,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$sshConfig = Join-Path $env:USERPROFILE ".ssh\config"

function Invoke-Sbc {
    param([string]$Command)
    ssh.exe -F $sshConfig $SshHost $Command
}

function Get-CloudflareUrl {
    $url = Invoke-Sbc "grep -hEo 'https://[-a-zA-Z0-9.]+\.trycloudflare\.com' ~/cloudflared-8080.log 2>/dev/null | tail -1"
    $latestUrl = $url | Select-Object -Last 1
    if (!$latestUrl) {
        return ""
    }
    return $latestUrl.Trim()
}

function Test-CloudflareHealth {
    param([string]$CloudflareUrl)

    if (!$CloudflareUrl) {
        return $false
    }

    try {
        $health = Invoke-WebRequest -Uri "$CloudflareUrl/backend-api/api/health" -UseBasicParsing -TimeoutSec 8
        return $health.StatusCode -eq 200
    } catch {
        return $false
    }
}

Push-Location $repoRoot
try {
    Write-Host "[start-dev-sbc] Checking SSH config..."
    if (!(Test-Path $sshConfig)) {
        throw "SSH config not found: $sshConfig"
    }

    Write-Host "[start-dev-sbc] Checking SBC web/API on localhost:$RemoteWebPort..."
    Invoke-Sbc "curl -fsS --max-time 5 http://localhost:$RemoteWebPort/backend-api/api/health >/dev/null"

    $cloudflareUrl = Get-CloudflareUrl
    $cloudflareOk = Test-CloudflareHealth $cloudflareUrl

    if (!$cloudflareOk) {
        Write-Host "[start-dev-sbc] Starting Cloudflare Tunnel: $SshHost localhost:$RemoteWebPort"
        Invoke-Sbc "nohup cloudflared tunnel --url http://localhost:$RemoteWebPort > ~/cloudflared-8080.log 2>&1 &"

        for ($attempt = 1; $attempt -le 8; $attempt++) {
            Start-Sleep -Seconds 3
            $cloudflareUrl = Get-CloudflareUrl
            if (Test-CloudflareHealth $cloudflareUrl) {
                $cloudflareOk = $true
                break
            }
        }

        if (!$cloudflareOk) {
            throw "Cloudflare Tunnel did not return HTTP 200 from /backend-api/api/health. See ~/cloudflared-8080.log on $SshHost."
        }
    }

    $apiTarget = "$cloudflareUrl/backend-api"
    Write-Host "[start-dev-sbc] Cloudflare URL is ready: $cloudflareUrl"
    Write-Host "[start-dev-sbc] Backend API target: $apiTarget"
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
