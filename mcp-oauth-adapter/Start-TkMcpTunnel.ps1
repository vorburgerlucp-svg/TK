#requires -Version 7.2
param(
    [Parameter(Mandatory)]
    [string] $Executable,
    [string] $Issuer,
    [switch] $Activate
)

$ErrorActionPreference = 'Stop'

if (-not $Activate) {
    Write-Host 'Vorbereitung: Kein Tunnel gestartet. Nach Freigabe -Activate verwenden.'
    return
}

$tunnelId = $env:CONTROL_PLANE_TUNNEL_ID
if ($tunnelId -cnotmatch '^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$') {
    throw 'CONTROL_PLANE_TUNNEL_ID muss die vollständige Tunnel-ID enthalten.'
}
$target = $env:MCP_SERVER_URL
if ($target -cnotmatch '^http://127\.0\.0\.1:([1-9][0-9]{0,4})/mcp$' -or
    [int] $Matches[1] -gt 65535 -or [int] $Matches[1] -eq 8790) {
    throw 'MCP_SERVER_URL muss auf den lokalen OAuth-Adapter zeigen (Standardport 8791).'
}
if ($Issuer -cnotmatch '^https://[a-z0-9][a-z0-9.-]+/$') {
    throw 'Issuer muss die konfigurierte Auth0-HTTPS-Basis-URL mit abschliessendem / sein.'
}
$metadata = Invoke-RestMethod -NoProxy -TimeoutSec 5 -MaximumRedirection 0 -Uri (
    $target.Substring(0, $target.Length - 4) + '/.well-known/oauth-protected-resource/mcp'
)
if (@($metadata.authorization_servers).Count -ne 1 -or
    $metadata.authorization_servers[0] -cne $Issuer) {
    throw 'Die lokalen Protected Resource Metadata stimmen nicht mit dem angegebenen Issuer überein.'
}
$path = (Resolve-Path -LiteralPath $Executable).ProviderPath
if ([IO.Path]::GetFileName($path) -notin @('tunnel-client-runtime.exe', 'tunnel-client.exe')) {
    throw 'Bitte die verifizierte Tunnelclient-EXE aus Release v0.0.21 verwenden.'
}

$info = [Diagnostics.ProcessStartInfo]::new($path)
$info.UseShellExecute = $false
# Keep only Windows runtime necessities. In particular, the child gets no
# adapter/upstream token, admin key, inherited profile or proxy overrides.
$info.Environment.Clear()
foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $info.Environment[$name] = $value }
}

$runtimeKey = $env:CONTROL_PLANE_API_KEY
if ([string]::IsNullOrWhiteSpace($runtimeKey)) {
    $entered = Read-Host 'Eingeschränkter Tunnel-Runtime-Key (Tunnels Read + Use)' -AsSecureString
    try {
        $runtimeKey = [Net.NetworkCredential]::new('', $entered).Password
    } finally {
        $entered.Dispose()
    }
}
if ([string]::IsNullOrWhiteSpace($runtimeKey)) { throw 'Runtime-Key fehlt.' }
$info.Environment['CONTROL_PLANE_API_KEY'] = $runtimeKey
$info.Environment['CONTROL_PLANE_TUNNEL_ID'] = $tunnelId
$info.Environment['MCP_SERVER_URL'] = $target
$info.ArgumentList.Add('run')
$info.ArgumentList.Add('--health.listen-addr=127.0.0.1:0')
$info.ArgumentList.Add('--mcp.oauth-trusted-origin=' + $Issuer.TrimEnd('/'))

$process = $null
try {
    $process = [Diagnostics.Process]::Start($info)
    $null = $info.Environment.Remove('CONTROL_PLANE_API_KEY')
    $runtimeKey = $null
    while (-not $process.WaitForExit(250)) { }
    if ($process.ExitCode -ne 0) { throw "Tunnelclient beendet ($($process.ExitCode))." }
} finally {
    $null = $info.Environment.Remove('CONTROL_PLANE_API_KEY')
    $runtimeKey = $null
    if ($process) {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}
