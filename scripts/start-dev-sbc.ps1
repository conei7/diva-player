param(
    [string]$SshHost = "diva-sbc",
    [int]$RemoteWebPort = 8080,
    [string]$PagesApiBase = "https://diva-player.pages.dev/backend-api",
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

function Test-PagesHealth {
    try {
        $health = Invoke-WebRequest -Uri "$PagesApiBase/api/ready" -UseBasicParsing -TimeoutSec 10
        return $health.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Sync-CloudflareOrigin {
    Invoke-Sbc "cd ~/diva-player && sh scripts/sync-quick-tunnel-to-cloudflare.sh"
}

Push-Location $repoRoot
try {
    Write-Host "[start-dev-sbc] Checking SSH config..."
    if (!(Test-Path $sshConfig)) {
        throw "SSH config not found: $sshConfig"
    }

    Write-Host "[start-dev-sbc] Checking SBC web/API on localhost:$RemoteWebPort..."
    Invoke-Sbc "curl -fsS --max-time 10 http://localhost:$RemoteWebPort/backend-api/api/ready >/dev/null"

    $cloudflareUrl = Get-CloudflareUrl
    $cloudflareOk = $false
    if ($cloudflareUrl) {
        try {
            Sync-CloudflareOrigin
            $cloudflareOk = Test-PagesHealth
        } catch {
            Write-Host "[start-dev-sbc] Existing tunnel could not be registered; replacing it."
        }
    }

    if (!$cloudflareOk) {
        Write-Host "[start-dev-sbc] Starting Cloudflare Tunnel: $SshHost localhost:$RemoteWebPort"
        Invoke-Sbc "nohup cloudflared tunnel --url http://localhost:$RemoteWebPort > ~/cloudflared-8080.log 2>&1 &"

        for ($attempt = 1; $attempt -le 8; $attempt++) {
            Start-Sleep -Seconds 3
            $cloudflareUrl = Get-CloudflareUrl
            if ($cloudflareUrl) {
                try {
                    Sync-CloudflareOrigin
                    if (Test-PagesHealth) {
                        $cloudflareOk = $true
                        break
                    }
                } catch {
                    # The Quick URL can exist in the log before its edge is ready.
                    # Retry the bounded registration loop without exposing it.
                }
            }
        }

        if (!$cloudflareOk) {
            throw "Cloudflare Pages did not return HTTP 200 from /backend-api/api/ready after tunnel registration. See ~/cloudflared-8080.log on $SshHost."
        }
    }

    $apiTarget = $PagesApiBase.TrimEnd('/')
    Write-Host "[start-dev-sbc] Cloudflare Pages origin is registered."
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
