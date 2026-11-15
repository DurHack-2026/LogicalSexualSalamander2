# Copies Room For Improvement to the Vultr GPU server and sets it up to run there all the time.
# Start it by double-clicking deploy-to-vultr.bat.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Fail($message) {
    Write-Host ''
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Run($exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail "$exe failed (exit code $LASTEXITCODE). See the messages above." }
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command scp -ErrorAction SilentlyContinue)) {
    Fail 'Windows OpenSSH is missing. Turn it on in Settings > System > Optional features > OpenSSH Client, then try again.'
}

# Read the SSH details already in .env
$settings = @{}
if (Test-Path -LiteralPath '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $settings[$Matches[1]] = $Matches[2].Trim('"', "'")
        }
    }
}
$target = $settings['TRELLIS_SSH_TARGET']
$key = $settings['TRELLIS_SSH_IDENTITY_FILE']
$sshPort = if ($settings['TRELLIS_SSH_PORT']) { $settings['TRELLIS_SSH_PORT'] } else { '22' }
if (-not $target) { Fail 'TRELLIS_SSH_TARGET is not set in .env (for example root@66.135.3.163).' }
if ($key -and -not (Test-Path -LiteralPath $key)) { Fail "The SSH key in .env was not found: $key" }
$serverHost = ($target -split '@')[-1]

$files = @(
    'server.js', 'Roomfit.html', 'floorplan.html', 'style.css', 'roomfit.js', 'floorplan.js',
    'room-config-storage.js', 'product-extractor.js', 'ai_server_trellis.py', 'setup-roomfit-server.sh',
    'update-trellis-api.sh', 'trellis_api.py'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { Fail "Missing file in this folder: $file" }
}

Write-Host 'Room For Improvement will be on the public internet, so it needs a password.'
Write-Host 'Anyone you give it to can use Room For Improvement and your GPU. Use at least 8 characters, no spaces or quotes.'
while ($true) {
    $secure = Read-Host 'Choose a password' -AsSecureString
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if ($password.Length -lt 8) { Write-Host 'Please use at least 8 characters.'; continue }
    if ($password -match '[\s"''`]') { Write-Host 'Please avoid spaces and quote marks.'; continue }
    break
}

$envFile = Join-Path $env:TEMP 'roomfit.env'
$envText = "ROOMFIT_HOST=0.0.0.0`nROOMFIT_PORT=3000`nROOMFIT_PASSWORD=$password`nROOMFIT_AUTOSTART_TRELLIS=true`nTRELLIS_API_URL=http://127.0.0.1:7861`n"
[IO.File]::WriteAllText($envFile, $envText)

$sshArgs = @('-p', $sshPort)
$scpArgs = @('-P', $sshPort)
if ($key) { $sshArgs += @('-i', $key); $scpArgs += @('-i', $key) }

try {
    Write-Host ''
    Write-Host "Connecting to $target ..."
    Run 'ssh' ($sshArgs + @($target, 'rm -rf /tmp/roomfit-upload && mkdir -p /tmp/roomfit-upload'))
    Write-Host 'Uploading Room For Improvement ...'
    Run 'scp' ($scpArgs + $files + @($envFile, "${target}:/tmp/roomfit-upload/"))
    Write-Host 'Setting up the server (the first time can take a few minutes) ...'
    Run 'ssh' ($sshArgs + @($target, 'sed -i ''s/\r$//'' /tmp/roomfit-upload/*.sh && bash /tmp/roomfit-upload/setup-roomfit-server.sh'))

    Write-Host ''
    Write-Host 'Next, the TRELLIS GPU program will be updated with the new trellis_api.py and restarted.'
    Write-Host 'Any 3D model being generated right now will be lost, and generating is unavailable for a few minutes while it reloads.'
    $answer = Read-Host 'Update and restart TRELLIS now? (Y/n)'
    if ($answer -match '^\s*n') {
        Write-Host 'Skipped the TRELLIS update.'
    } else {
        & ssh @($sshArgs + @($target, 'bash /tmp/roomfit-upload/update-trellis-api.sh /tmp/roomfit-upload/trellis_api.py'))
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'TRELLIS is updated and running.' -ForegroundColor Green
        } elseif ($LASTEXITCODE -eq 2) {
            Write-Host 'TRELLIS was not running, so it could not be restarted. Start it as usual, then run this deploy again.' -ForegroundColor Yellow
        } else {
            Write-Host 'The TRELLIS update hit a problem; see the messages above. The site itself was deployed.' -ForegroundColor Yellow
        }
    }
} finally {
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
    & ssh @($sshArgs + @($target, 'rm -rf /tmp/roomfit-upload'))
}

Write-Host ''
Write-Host 'Done! Room For Improvement is now online:' -ForegroundColor Green
Write-Host "    http://${serverHost}:3000" -ForegroundColor Green
Write-Host 'Any username works; use the password you just chose.'
Write-Host 'If the page does not load, open port 3000 (TCP) in the Vultr firewall for this server.'
