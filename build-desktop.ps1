$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "Python virtual environment not found at .venv\Scripts\python.exe"
}

& $Python -m pip install -r requirements.txt -r requirements-desktop.txt
if ($LASTEXITCODE -ne 0) {
    throw "Dependency installation failed."
}

& $Python -m PyInstaller --clean --noconfirm DSS.spec
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
}

Write-Host ""
Write-Host "Desktop build complete:"
Write-Host "  $ProjectRoot\dist\DSS\DSS.exe"
