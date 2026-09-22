param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$WebUrl, [string]$Registry = 'https://registry.npmjs.org')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'CodyPreview'
$tools = Join-Path $base 'tools'
$source = Join-Path $base 'source'
$previewHome = Join-Path $base 'home'
$lock = Join-Path $base 'build.lock'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$nodeVersion = '24.18.0'
$nodeRoot = Join-Path $tools "node-v$nodeVersion-win-$arch"
New-Item -ItemType Directory -Force $tools,$source,(Join-Path $previewHome 'userdata') | Out-Null
Set-Location $base
$lockHandle = [IO.File]::Open($lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
if (!(Test-Path (Join-Path $nodeRoot 'node.exe'))) {
  Write-Host "Installing private Windows Node $nodeVersion ($arch)..."
  $zip = Join-Path $tools 'node.zip'
  $name = "node-v$nodeVersion-win-$arch.zip"
  Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$name" -OutFile $zip -UseBasicParsing
  $checksums = (Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
  $expected = (($checksums -split "`n" | Where-Object { $_.Trim().EndsWith(" $name") }) -split '\s+')[0]
  if (!$expected -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Node download checksum mismatch.' }
  Expand-Archive $zip -DestinationPath $tools -Force
}
$env:PATH = "$nodeRoot;$(Join-Path $tools 'npm');$env:PATH"
# Use Cody's public dependency registry without changing the user's npm configuration.
$env:npm_config_registry = 'https://registry.npmjs.org'
$env:PNPM_CONFIG_REGISTRY = 'https://registry.npmjs.org'
if (!(Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows before building Cody Preview.' }
if (!(Test-Path (Join-Path $tools 'npm/vp.cmd'))) {
  & (Join-Path $nodeRoot 'npm.cmd') install --prefix (Join-Path $tools 'npm') --global vite-plus@0.3.0
  if ($LASTEXITCODE -ne 0) { throw 'Vite+ installation failed.' }
}
if (!(Test-Path (Join-Path $tools 'npm/pnpm.cmd'))) {
  & (Join-Path $nodeRoot 'npm.cmd') install --prefix (Join-Path $tools 'npm') --global pnpm@11.10.0
  if ($LASTEXITCODE -ne 0) { throw 'pnpm installation failed.' }
}
Set-Location $source
$env:PNPM_CONFIG_REGISTRY = $Registry
# Source-only manifest allows stale source removal without touching cached node_modules.
$manifest = Join-Path $base 'source-files.txt'
if (Test-Path $manifest) {
  Get-Content $manifest | ForEach-Object {
    $path = [IO.Path]::GetFullPath((Join-Path $source $_))
    if (!$path.StartsWith($source + [IO.Path]::DirectorySeparatorChar)) { throw 'Invalid staging manifest.' }
    if (Test-Path $path -PathType Leaf) { Remove-Item $path -Force }
  }
}
& tar.exe -tf $Archive | Set-Content $manifest
& tar.exe -xf $Archive -C $source
if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed.' }
& pnpm install --frozen-lockfile --filter=t3... --filter=@t3tools/web... --filter=@t3tools/desktop... --filter=@t3tools/scripts...
if ($LASTEXITCODE -ne 0) { throw 'Windows dependency installation failed.' }
& vp run build:desktop
if ($LASTEXITCODE -ne 0) { throw 'Windows desktop build failed.' }
& node -e "const {createRequire}=require('node:module'); const r=createRequire(process.cwd()+'/apps/desktop/package.json'); require(r.resolve('electron/install.js'));"
if ($LASTEXITCODE -ne 0) { throw 'Electron runtime installation failed.' }
$settings = Join-Path $previewHome 'userdata/desktop-settings.json'
if (!(Test-Path $settings)) { '{"localEnvironmentEnabled":false}' | Set-Content $settings }
$env:T3CODE_HOME = $previewHome
$env:APPDATA = Join-Path $base 'profile'
New-Item -ItemType Directory -Force $env:APPDATA | Out-Null
$env:VITE_DEV_SERVER_URL = $WebUrl
Write-Host 'Opening Cody Preview. Add the WSL preview server using its pairing URL. Start Cody Dev in WSL first.'
& node apps/desktop/scripts/start-electron.mjs
if ($LASTEXITCODE -ne 0) { throw 'Cody Preview exited with an error.' }
} finally {
  $lockHandle.Dispose()
}
