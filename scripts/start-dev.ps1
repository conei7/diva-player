param()
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $here\..\

Write-Host "[start-dev] Starting backend (docker compose)..."
docker compose -f backend/docker-compose.yml up -d --build
if ($LASTEXITCODE -ne 0) {
    Write-Error "[start-dev] docker compose failed (exit $LASTEXITCODE)"
    Pop-Location
    exit $LASTEXITCODE
}

Write-Host "[start-dev] Backend started. Starting Vite (frontend)..."
npm run dev

Pop-Location
