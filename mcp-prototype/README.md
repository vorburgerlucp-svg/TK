# TK Lern-App · Privater MCP-Prototyp

Phase 1 verwendet eine eigens erstellte Rechnungswesenaufgabe. Der Dienst lädt
keinen Katalog und keinen Lernstand der TK-App. Er führt keine externen
API-Aufrufe aus. Die Testereignisse liegen pro Prozess im Arbeitsspeicher.

## Lokal starten

Node.js 22 oder neuer und npm werden benötigt. Die Befehle sind für eine
POSIX-Shell und werden im Verzeichnis `mcp-prototype` ausgeführt.

```sh
npm ci
npm test
TK_MCP_TOKEN="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
export TK_MCP_TOKEN
npm start
```

Der Dienst lauscht auf `http://127.0.0.1:8790/mcp` (Streamable HTTP, POST).
`TK_MCP_PORT` kann den Port ändern. Ein lokaler MCP-Client verwendet
`Authorization: Bearer <Wert von TK_MCP_TOKEN>`. Das Token wie ein Passwort
behandeln und lokal als Umgebungsvariable setzen. Für einen neuen Testlauf kann
ein neues Token erzeugt werden. Der Start ohne gültiges Token schlägt fehl.

### Windows PowerShell auf dem HP

Git und Node.js 22 oder neuer installieren. Im übertragenen Checkout in
`mcp-prototype` wechseln. `npm.cmd` verwendet den Windows-Starter von npm.

```powershell
node --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci fehlgeschlagen' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'MCP-Tests fehlgeschlagen' }

Remove-Item Env:TK_MCP_PORT -ErrorAction SilentlyContinue
$env:TK_MCP_TOKEN = node -e 'console.log(require(process.argv[1]).randomBytes(32).toString(process.argv[2]))' node:crypto hex
if ($LASTEXITCODE -ne 0 -or $env:TK_MCP_TOKEN -cnotmatch '^[a-f0-9]{64}$') {
    Remove-Item Env:TK_MCP_TOKEN -ErrorAction SilentlyContinue
    throw 'Testtoken konnte nicht erzeugt werden'
}
try {
    npm.cmd start
} finally {
    Remove-Item Env:TK_MCP_TOKEN -ErrorAction SilentlyContinue
}
```

In einem zweiten PowerShell-Fenster prüfen, dass die Spalte
`LocalAddress` für den MCP-Listener ausschliesslich `127.0.0.1` zeigt.

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8790 |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Keinen Firewall- oder Router-Port öffnen. Bei einem Portkonflikt den
angezeigten Prozess identifizieren. Port 8787 gehört der KI-Zentrale.

### Entwicklungszweig auf den HP übertragen

Im Quell-Checkout nach der Verifikation ein vollständiges Git-Bundle
des lokalen Zweigs erstellen. Dieser Weg braucht keinen GitHub-Push.

```sh
git bundle create /tmp/tk-mcp-phase-2.bundle phase-1/private-mcp-prototype
git bundle verify /tmp/tk-mcp-phase-2.bundle
sha256sum /tmp/tk-mcp-phase-2.bundle
```

Die Bundle-Datei über einen privaten Weg, etwa einen USB-Datenträger,
auf den HP kopieren. Den SHA-256-Wert mit dem Quellwert vergleichen und
in ein neues Verzeichnis klonen. Das Bundle enthält die eingecheckte
Branch-Historie. Umgebungstokens und `node_modules` werden nicht übertragen.

```powershell
Get-FileHash .\tk-mcp-phase-2.bundle -Algorithm SHA256
git clone --branch phase-1/private-mcp-prototype --single-branch .\tk-mcp-phase-2.bundle TK-MCP-Test
if ($LASTEXITCODE -ne 0) { throw 'Git-Bundle konnte nicht ausgecheckt werden' }
Set-Location .\TK-MCP-Test\mcp-prototype
git log -1 --oneline
```

## Werkzeuge

| Werkzeug | Eingabe | Verhalten |
| --- | --- | --- |
| `tk_status` | Kein Argument | Status und Speichertyp prüfen. |
| `tk_testfrage_abrufen` | Kein Argument | Frage ohne Lösung liefern und einen Testversuch mit UUID eröffnen. |
| `tk_testantwort_bewerten` | `versuchId`, `antwort` | Eine Textantwort (max. 1’000 Zeichen) bewerten und danach die Musterlösung liefern. Dieselbe Antwort darf wiederholt werden. Eine abweichende Antwort erfordert einen neuen Versuch. |
| `tk_testlernstand_speichern` | `versuchId`, `freigabe: true` | Einen bewerteten Versuch speichern. Aufrufe mit derselben Versuchs-ID liefern dasselbe Ereignis. `neu` zeigt an, ob es gerade angelegt wurde. |
| `tk_testlernstand_lesen` | Kein Argument | Anzahl und bis zu 20 der zuletzt gespeicherten Testereignisse liefern. |

## Verbindung mit ChatGPT vorbereiten

Der lokale Dienst unterstützt das von ChatGPT dokumentierte Streamable
HTTP. Initialisierung, Werkzeugliste und Aufrufe sind mit einem lokalen
MCP-SDK-Client getestet. Die Erkennung über Tunnel, OAuth-Anmeldung
und Aufrufe aus ChatGPT brauchen einen separaten Verbindungstest.
[MCP-Verbindungsoptionen](https://developers.openai.com/api/docs/guides/custom-mcp-server)

1. Im vorgesehenen ChatGPT-Konto auf dem Web prüfen, ob **Plugins → Eigenen
   MCP-Server hinzufügen** verfügbar ist. Die OpenAI-Hilfe nennt Business und
   Enterprise/Edu für die vollständige Unterstützung. Die Rolle und die
   Workspace-Einstellungen bestimmen, wer eigene Verbindungen anlegen und
   verwenden kann. [OpenAI-Hilfe für eigene MCP-Verbindungen](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
2. Für die private Verbindung nach Freigabe einen **Secure MCP Tunnel** mit
   der zuständigen Platform-Organisation und dem Ziel-Workspace einrichten.
   Dafür werden eine Tunnel-ID, ein eingeschränkter Laufzeitschlüssel und
   die erforderlichen Tunnelrechte benötigt. Der lokale Tunnelclient braucht
   ausgehendes HTTPS und Zugriff auf den lokalen Dienst. [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
3. Für die ChatGPT-Verbindung einen OAuth-fähigen Adapter vor den
   lokalen Dienst setzen. Der Adapter stellt Protected Resource Metadata
   bereit, validiert OAuth-Zugriffstokens (Aussteller, Zielgruppe, Gültigkeit,
   erlaubtes Testkonto und Berechtigungen) und ruft den Loopback-Dienst
   mit dem lokalen Token auf. Der Tunnel zeigt dann auf den Adapter.
   Die aktuelle ChatGPT-Konfiguration akzeptiert das lokale Bearer-Secret
   nicht als statischen API-Schlüssel. Das Secret bleibt am lokalen Dienst.
   Adapter, Identitätsanbieter und Tunnel sind hier bewusst noch unkonfiguriert.
   Für OAuth den exakten ChatGPT-Redirect beim Identitätsanbieter
   registrieren und die Erreichbarkeit seiner Endpunkte prüfen. Der
   Tunnel transportiert die MCP- und Erkennungsanfragen. Die browserseitige
   Anmeldung beim Identitätsanbieter benötigt einen eigenen erreichbaren
   HTTPS-Endpunkt.
   [OpenAI Plugin-Authentifizierung](https://developers.openai.com/plugins/build/auth)
   · [MCP-Verbindungsoptionen](https://developers.openai.com/api/docs/guides/custom-mcp-server)
4. Die Verbindung im Web als privaten Entwurf anlegen, OAuth-Anmeldung und
   Werkzeugerkennung testen und danach den Ablauf in Live auf HP und iPad
   prüfen. Bei einer von ChatGPT verlangten Aktionsfreigabe am Bildschirm
   bestätigen. [OpenAI zu Plugins in Live und Aktionsfreigaben](https://help.openai.com/en/articles/20001274-chatgpt-voice)

Nach ausdrücklicher Freigabe den Tunnelclient auf dem HP auf den lokalen
OAuth-Adapter ausrichten. Tunnelanlage erfordert `Tunnels Read + Manage`,
Auswahl und Betrieb erfordern `Tunnels Read + Use`. Das Profil mit
`tunnel-client doctor --profile <profil> --explain` prüfen und mit
`tunnel-client run --profile <profil>` starten. Danach im ChatGPT-Web
**Plugins → Eigenen MCP-Server hinzufügen → Tunnel → OAuth** wählen,
den privaten Entwurf installieren und zuerst im Textchat `tk_status`
aufrufen. Für Live dieselbe berechtigte Kontoverbindung und den
Mikrofonzugriff auf dem HP bzw. iPad prüfen.
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Späterer Abnahmetest in ChatGPT Live

> Nutze den privaten TK-Prototyp. Rufe eine Testfrage ab und stelle sie mir
> mündlich. Warte auf meine Antwort. Bewerte genau diese Antwort mit dem
> Bewertungswerkzeug. Zeige die Musterlösung erst danach. Frag mich, ob ich
> das Test-Lernereignis speichern möchte. Speichere es erst nach meiner
> Zustimmung und der gegebenenfalls angezeigten Freigabe. Lies den
> Lernstand danach wieder aus.

Mit leerem Speicher muss die Anzahl nach dem Ablauf **eins** betragen.
Eine Wiederholung des Speicheraufrufs mit derselben Versuchs-ID muss
dieselbe Ereignis-ID und weiterhin **eins** liefern.
Führe beim Live-Test zuerst einen Durchlauf mit abgelehnter Speicherung
durch und prüfe, dass die Anzahl null bleibt. Danach mit einem neuen
Versuch zustimmen und eine allfällige Freigabe am Bildschirm bestätigen.
Als synthetische Antwort eignet sich «3’000 Franken pro Jahr».

## Sicherheit und Grenzen

- Der Loopback-Listener prüft Host, Herkunft und Bearer-Token vor jeder
  MCP-Anfrage. JSON-Anfragen sind auf 16 KiB begrenzt, Werkzeugargumente
  auf die deklarierten Felder. Es gibt höchstens 1’000 Versuche pro Prozess.
- Die Versuchs-ID bindet Abruf, Antwort und Ereignis aneinander. Der
  Fragenabruf liefert nur den Aufgabentext mit Metadaten. Ein gültiger
  Antwortaufruf gibt danach die Musterlösung zurück. Der Dienst kann
  allein anhand der API-Eingaben keine menschliche Antwort nachweisen.
- `freigabe: true` ist ein Eingabefeld. Die MCP-Schreibannotation
  kennzeichnet die Aktion für den Host. Die tatsächliche Bestätigung
  durch den Menschen hängt vom ChatGPT-Client und dessen Einstellungen ab
  und muss im Abnahmetest überprüft werden.
- Die Bewertung verwendet Zahlenmuster für genau eine Aufgabe. Sie
  erfasst frei gesprochene Begründungen und sprachliche Mehrdeutigkeiten
  nur eingeschränkt. Der Dienst hält einen Antwort-Hash zur
  Wiederholungserkennung im RAM und speichert im Ereignis nur die
  Bewertung und Metadaten. ChatGPT kann Antworten nach seinen eigenen
  Einstellungen verarbeiten und im Gesprächsverlauf anzeigen.
- Alle Versuche und Ereignisse verfallen beim Neustart. Ein Token gilt
  für die gesamte Testinstanz. Dieses Modell ist für einen privaten,
  synthetischen Einzeltest gedacht.
