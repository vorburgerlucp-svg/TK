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

Der Dienst lauscht auf `http://127.0.0.1:8787/mcp` (Streamable HTTP, POST).
`TK_MCP_PORT` kann den Port ändern. Ein lokaler MCP-Client verwendet
`Authorization: Bearer <Wert von TK_MCP_TOKEN>`. Das Token wie ein Passwort
behandeln und lokal als Umgebungsvariable setzen. Für einen neuen Testlauf kann
ein neues Token erzeugt werden. Der Start ohne gültiges Token schlägt fehl.

## Werkzeuge

| Werkzeug | Eingabe | Verhalten |
| --- | --- | --- |
| `tk_status` | Kein Argument | Status und Speichertyp prüfen. |
| `tk_testfrage_abrufen` | Kein Argument | Frage ohne Lösung liefern und einen Testversuch mit UUID eröffnen. |
| `tk_testantwort_bewerten` | `versuchId`, `antwort` | Eine Textantwort (max. 1’000 Zeichen) bewerten und danach die Musterlösung liefern. Dieselbe Antwort darf wiederholt werden. Eine abweichende Antwort erfordert einen neuen Versuch. |
| `tk_testlernstand_speichern` | `versuchId`, `freigabe: true` | Einen bewerteten Versuch speichern. Aufrufe mit derselben Versuchs-ID liefern dasselbe Ereignis. `neu` zeigt an, ob es gerade angelegt wurde. |
| `tk_testlernstand_lesen` | Kein Argument | Anzahl und bis zu 20 der zuletzt gespeicherten Testereignisse liefern. |

## Verbindung mit ChatGPT vorbereiten

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
   [OpenAI Plugin-Authentifizierung](https://developers.openai.com/plugins/build/auth)
   · [MCP-Verbindungsoptionen](https://developers.openai.com/api/docs/guides/custom-mcp-server)
4. Die Verbindung im Web als privaten Entwurf anlegen, OAuth-Anmeldung und
   Werkzeugerkennung testen und danach den Ablauf in Live auf HP und iPad
   prüfen. Bei einer von ChatGPT verlangten Aktionsfreigabe am Bildschirm
   bestätigen. [OpenAI zu Plugins in Live und Aktionsfreigaben](https://help.openai.com/en/articles/20001274-chatgpt-voice)

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
