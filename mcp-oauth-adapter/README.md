# TK Lern-App · OAuth-Adapter für den privaten Verbindungstest

Der Adapter läuft getrennt auf `127.0.0.1:8791/mcp` und leitet auf dem
gleichen Rechner an den unveränderten Prototyp auf `127.0.0.1:8790/mcp`
weiter. Login und Token-Ausstellung übernimmt Auth0. Der Adapter ist ein
OAuth-Ressourcenserver. Ohne gültige lokale Konfiguration endet der
Start; mit eingetragenen Werten lauscht er lokal. Eine erfolgreiche
Anmeldung mit einem realen Tenant und über den Tunnel ist separat
nachzuweisen.

## Auth0 vorbereiten

1. Einen separaten Test-Tenant und genau einen vorgesehenen Testbenutzer
   einrichten. Öffentliche Registrierung und unnötige Verbindungen
   deaktivieren. Die feste Auth0-Benutzer-ID (`user_id`, z. B.
   `auth0|…`) aus dem Dashboard übernehmen.
2. Eine Custom API mit RS256 und dem **RFC 9068 Access Token Profile**
   registrieren. Als API-Identifier exakt die öffentliche HTTPS-Resource
   verwenden, die ChatGPT über den zugeordneten Tunnel für diesen MCP-
   Server sieht. Der Tunnel kann das PRMD-Feld `resource` umschreiben.
   Die konkrete URL aus der Tunnel-Konfiguration bzw. nach Freigabe aus
   der Discovery verifizieren. Den Identifier, den veröffentlichten
   `resource`-Wert und den erwarteten `aud` gleich halten. Die
   Loopback-Adresse ist nur das lokale Tunnelziel.
3. Im Tenant unter **Settings → Advanced** das **Resource Parameter
   Compatibility Profile** aktivieren (RFC 8707). So kann Auth0 den
   von ChatGPT gesendeten `resource`-Parameter der API zuordnen. Kurze
   Token-Laufzeit konfigurieren. `tk:read` und `tk:write` als
   API-Permissions anlegen. Mit aktiviertem RBAC dem Testbenutzer nur
   die vorgesehenen Berechtigungen erteilen. Der Adapter nutzt den
   erteilten `scope`-Claim.
4. Einen OAuth-Client manuell registrieren und den **exakten Redirect
   URI aus ChatGPT** erlauben. Den von ChatGPT für die manuelle
   Registrierung angezeigten Client-Authentifizierungstyp in Auth0
   konfigurieren. Authorization Code mit PKCE S256 verwenden.
   Client Credentials, Implicit und Password Grant für diesen Client
   deaktivieren. Refresh Tokens nur bei Bedarf und dann mit Rotation
   zulassen. Die Client-ID lokal setzen. Ein allenfalls erforderliches
   Client-Secret gehört nur in die dafür vorgesehene ChatGPT-
   OAuth-Konfiguration. Der lokale Adapter braucht es nicht.
5. OIDC/Authorization-Server-Metadaten, PKCE und Auth0-Endpunkte
   prüfen. Der Tunnel stellt den Auth0-Login nicht bereit. Der Browser
   und ChatGPT benötigen Zugriff auf die jeweiligen Auth0-Endpunkte.
   Der Adapter benötigt ausgehend HTTPS für Auth0-JWKS.

[Auth0 und RFC 8707](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0) ·
[Auth0 Access Token Profile](https://auth0.com/blog/secure-csharp-mcp-server-with-auth0/) ·
[OpenAI OAuth und Clientregistrierung](https://developers.openai.com/plugins/build/auth) ·
[MCP-Autorisierung](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## Windows, lokaler Start

Node.js 22 oder neuer. In PowerShell 7.2+ aus dem Repo-Stamm zunächst
installieren und testen:

```powershell
npm.cmd --prefix .\mcp-prototype ci
npm.cmd --prefix .\mcp-oauth-adapter ci
npm.cmd --prefix .\mcp-prototype test
npm.cmd --prefix .\mcp-oauth-adapter test
```

Danach in einer PowerShell-Sitzung die Auth0-Daten eingeben und beide
Prozesse mit demselben lokal erzeugten Prototyp-Token starten. Den
Prototyp-Prozess nur mit seiner eigenen Umgebung starten, bevor die
Auth0-Konfiguration gesetzt wird.

```powershell
$env:TK_MCP_TOKEN = node -e 'console.log(require(process.argv[1]).randomBytes(32).toString(process.argv[2]))' node:crypto hex
if ($LASTEXITCODE -ne 0 -or $env:TK_MCP_TOKEN -cnotmatch '^[a-f0-9]{64}$') {
    Remove-Item Env:TK_MCP_TOKEN -ErrorAction SilentlyContinue
    throw 'Lokales Prototyp-Token konnte nicht erzeugt werden'
}
$env:TK_MCP_PORT = '8790'
$env:TK_OAUTH_PORT = '8791'
$prototype = $null
try {
    $prototype = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'src/server.js' `
        -WorkingDirectory (Resolve-Path .\mcp-prototype).Path -PassThru

    $env:TK_OAUTH_ISSUER = Read-Host 'Auth0-Issuer (HTTPS mit abschliessendem /)'
    $env:TK_OAUTH_RESOURCE = Read-Host 'Exakte HTTPS-Resource-URL des TK-Prototyps'
    $env:TK_OAUTH_SUBJECT = Read-Host 'Auth0 user_id des erlaubten Testbenutzers'
    $env:TK_OAUTH_CLIENT_ID = Read-Host 'Manuell registrierte OAuth Client-ID'
    npm.cmd --prefix .\mcp-oauth-adapter start
} finally {
    if ($prototype -and -not $prototype.HasExited) { Stop-Process -Id $prototype.Id }
    Remove-Item Env:TK_MCP_TOKEN, Env:TK_MCP_PORT, Env:TK_OAUTH_PORT, Env:TK_OAUTH_ISSUER, Env:TK_OAUTH_RESOURCE, Env:TK_OAUTH_SUBJECT, Env:TK_OAUTH_CLIENT_ID -ErrorAction SilentlyContinue
}
```

Aus einem zweiten Fenster lokal prüfen:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8790,8791 |
    Select-Object LocalAddress, LocalPort, OwningProcess
Invoke-RestMethod http://127.0.0.1:8791/.well-known/oauth-protected-resource/mcp
curl.exe -i http://127.0.0.1:8791/mcp
```

Beide Listener müssen ausschliesslich `127.0.0.1` zeigen. Die
Metadaten enthalten Resource, Issuer und Scopes. Der letzte Aufruf
erhält HTTP 401 mit `WWW-Authenticate`.

## Tunnel Runtime v0.0.21 unter Windows

Im Runtime-ZIP heisst die Datei `tunnel-client-runtime.exe`, im
Vollpaket `tunnel-client.exe`. Vor Verwendung das ZIP mit
`Get-FileHash -Algorithm SHA256` gegen die Release-Datei
`SHA256SUMS.txt` prüfen. Lokal und ohne Verbindung die Hilfe anzeigen:

```powershell
& C:\Pfad\tunnel-client-runtime.exe run --help
```

| Bedeutung | v0.0.21 Flag | Umgebungsvariable |
| --- | --- | --- |
| Vollständige Tunnel-ID | `--control-plane.tunnel-id` | `CONTROL_PLANE_TUNNEL_ID` |
| Eingeschränkter Runtime-Key | nur die Umgebungsvariable verwenden | `CONTROL_PLANE_API_KEY` |
| MCP-Ziel des Hauptkanals | `--mcp.server-url` | `MCP_SERVER_URL` |
| OAuth-Erkennung | `--mcp.oauth-discovery` | `MCP_OAUTH_DISCOVERY`, Standard `auto` |
| Erlaubter Auth0-Origin für Discovery | `--mcp.oauth-trusted-origin` | `MCP_OAUTH_TRUSTED_ORIGINS` |
| Health-Listener | `--health.listen-addr=127.0.0.1:0` | `HEALTH_LISTEN_ADDR` |

Release-ZIPs für Windows und CLI-Hilfe eines verifizierten v0.0.21-Builds
wurden geprüft. Die lokale EXE auf dem HP wurde dabei nicht ausgeführt.
Die Variante und Architektur auf dem HP gegen die Release-Liste prüfen.
[Release samt Prüfsummen](https://github.com/openai/tunnel-client/releases/tag/v0.0.21) ·
[Konfiguration v0.0.21](https://github.com/openai/tunnel-client/blob/v0.0.21/docs/configuration.md) ·
[OAuth-Weiterleitung v0.0.21](https://github.com/openai/tunnel-client/blob/v0.0.21/docs/onboarding.md)

Nach ausdrücklicher Freigabe in einer separaten PowerShell starten.
Der Tunnel muss dem berechtigten ChatGPT-Workspace zugeordnet sein.
Der Runtime-Key braucht **Tunnels Read + Use**. Das Skript ohne
`-Activate` startet keinen Prozess. Mit `-Activate` verwendet es den
gesetzten `CONTROL_PLANE_API_KEY` oder fragt ihn verdeckt ab und
reicht ihn nur in der Umgebung des Tunnelprozesses weiter:

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = Read-Host 'Vollständige Tunnel-ID von TK-Lerntrainer-HP'
$env:MCP_SERVER_URL = 'http://127.0.0.1:8791/mcp'
$issuer = Read-Host 'Dieselbe Auth0-Issuer-URL wie beim lokalen Adapter'
try {
    .\mcp-oauth-adapter\Start-TkMcpTunnel.ps1 -Executable 'C:\Pfad\tunnel-client-runtime.exe' -Issuer $issuer -Activate
} finally {
    Remove-Item Env:CONTROL_PLANE_TUNNEL_ID, Env:CONTROL_PLANE_API_KEY, Env:MCP_SERVER_URL -ErrorAction SilentlyContinue
}
```

Das Skript vergleicht den Issuer vor dem Start mit den lokalen PRMD
und erlaubt nur diesen zusätzlichen Origin für OAuth-Discovery.
Der Tunnel soll den OAuth-Authorization-Header weiterleiten. Keine
statischen Bearer-Header im Tunnel hinterlegen. Die Verbindung auf
ChatGPT-Web privat hinzufügen (**Tunnel → OAuth**), mit dem erlaubten
Auth0-Konto anmelden und die Discovery sowie `tk_status` im Textchat
prüfen. Vor dem Live-Test sicherstellen, dass das Konto den Entwurf
verwenden kann und `tk:write` tatsächlich erteilt wurde.
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) ·
[Eigene ChatGPT-MCP-Verbindung](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## Sicherheitsgrenzen und Abnahme

- PRMD ist öffentlich lesbar. `/mcp` verlangt serverweit OAuth. Der
  Adapter validiert RS256-Signaturen über Auth0-JWKS, Access-Token-Typ,
  Issuer, Audience, Ablauf, feste Benutzer- und Client-ID. Er akzeptiert
  nur das konfigurierte Testkonto. Für die Laufzeit von Bearer-Tokens
  kurze Auth0-TTL und einen separaten Test-Tenant verwenden. Der Adapter
  akzeptiert zusätzlich nur Tokens, die innerhalb der letzten Stunde
  ausgestellt wurden.
- `tk_status` und `tk_testlernstand_lesen` benötigen `tk:read`.
  Frage abrufen, bewerten und speichern benötigen `tk:write`. Die
  ersten beiden Aktionen erzeugen oder verändern einen Versuch im RAM.
  Die Prüfung der Scopes erfolgt bei jedem Tool-Aufruf auf dem Server.
- Der Adapter akzeptiert einzelne JSON-RPC-Anfragen über Streamable
  HTTP. Die fünf Werkzeuge sind explizit freigegeben. Standalone-SSE,
  Batch-Payloads und andere Ressourcenmethoden sind nicht Teil des
  Prototyps. Der OAuth-Token gelangt nicht an den Prototyp. Der
  Prototyp-Bearer gelangt weder an OpenAI noch an Auth0. Schlüssel
  bleiben aus Git, Launch-Argumenten und Logs.
- Lokale Prozesse und Administratoren auf dem HP gehören zur
  Vertrauensgrenze. Kein LAN-Binding und keine eingehenden
  Firewall-Regeln einrichten. Der Prototyp hält nur synthetische
  Ereignisse im Arbeitsspeicher.
- Nach Freigabe im echten OAuth-Ablauf prüfen, ob die vom Tunnel
  veröffentlichte Resource exakt als `aud` im Access-Token ankommt,
  ein fremdes Konto abgewiesen wird und nur die erwarteten Scopes
  gelten. Danach in Live eine synthetische Rechnungswesenfrage
  beantworten, die Musterlösung erst nach Abgabe erwarten, die
  Speicherung am Bildschirm freigeben, den Aufruf wiederholen und
  genau ein Ereignis lesen. Das Feld `freigabe: true` ersetzt die
  menschliche Freigabe nicht.
