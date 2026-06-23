$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistRoot = Join-Path $ProjectRoot "dist\DSS"
$InternalRoot = Join-Path $DistRoot "_internal"
$DistExe = Join-Path $DistRoot "DSS.exe"

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        throw "Source directory not found: $Source"
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

if (-not (Test-Path $DistExe)) {
    throw "Desktop dist was not found. Run .\build-desktop.ps1 first."
}

$frontendSource = Join-Path $ProjectRoot "frontend"
$frontendDestination = Join-Path $InternalRoot "frontend"
$scenarioSource = Join-Path $ProjectRoot "scenarios"
$scenarioDestination = Join-Path $InternalRoot "scenarios"

Copy-DirectoryContents -Source $frontendSource -Destination $frontendDestination
Copy-DirectoryContents -Source $scenarioSource -Destination $scenarioDestination

$exeTimestamp = (Get-Item $DistExe).LastWriteTimeUtc
$compiledSources = @(
    (Join-Path $ProjectRoot "backend"),
    (Join-Path $ProjectRoot "desktop_launcher.py"),
    (Join-Path $ProjectRoot "DSS.spec"),
    (Join-Path $ProjectRoot "requirements.txt"),
    (Join-Path $ProjectRoot "requirements-desktop.txt")
)

$needsRebuild = $false
foreach ($source in $compiledSources) {
    if (-not (Test-Path $source)) {
        continue
    }

    $latestSource = Get-Item $source
    if ($latestSource.PSIsContainer) {
        $latestSource = Get-ChildItem -Path $source -Recurse -File |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
    }

    if ($latestSource -and $latestSource.LastWriteTimeUtc -gt $exeTimestamp) {
        $needsRebuild = $true
        break
    }
}

Write-Host "Synced frontend and scenarios into:"
Write-Host "  $InternalRoot"

if ($needsRebuild) {
    Write-Warning "Backend or launcher sources changed after DSS.exe was built. Run .\build-desktop.ps1 to update the executable."
} else {
    Write-Host "DSS.exe is newer than compiled Python sources."
}
