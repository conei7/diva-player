param()
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $here\\..\\

Write-Host "[start-dev] Checking Docker daemon..."
docker info > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "[start-dev] Docker daemon appears to be unavailable."
    $ans = Read-Host "Start frontend only? (y/N)"
    if ($ans -match '^[Yy]') {
        Write-Host "[start-dev] Starting Vite (frontend) only..."
        npm run dev
        Pop-Location
        exit 0
    } else {
        Write-Error "[start-dev] Aborting because Docker is not available."
        Pop-Location
        exit 1
    }
}

Write-Host "[start-dev] Starting backend (docker compose)..."
docker compose -f backend/docker-compose.yml up -d --build
if ($LASTEXITCODE -ne 0) {
    Write-Warning "[start-dev] docker compose failed (exit $LASTEXITCODE)."
    $ans = Read-Host "Proceed to start frontend only? (y/N)"
    if ($ans -match '^[Yy]') {
        Write-Host "[start-dev] Starting Vite (frontend) only..."
        npm run dev
        Pop-Location
        exit 0
    } else {
        Pop-Location
        exit $LASTEXITCODE
    }
}

Write-Host "[start-dev] Backend started. Starting Vite (frontend)..."
npm run dev

Pop-Location
