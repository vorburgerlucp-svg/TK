import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const question = {
  frageId: 'tk-synthetisch-rw-001',
  fach: 'Rechnungswesen',
  frage: 'Eine Maschine kostet 12’000 Franken. Die Nutzungsdauer beträgt vier Jahre, der Restwert null Franken. Wie hoch ist die lineare Abschreibung pro Jahr?'
};
const solution = 'CHF 12’000 geteilt durch 4 Jahre ergeben CHF 3’000 Abschreibung pro Jahr.';
const id = z.uuid();
const empty = z.strictObject({});
const readOnly = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function error(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function evaluate(answer) {
  const normalized = answer.toLowerCase()
    .replace(/\bdrei\s*tausend\b/g, '3000')
    .replace(/\b(3|12)[’'.\s]000\b/g, (_, thousands) => thousands + '000');
  if (/\b(?:nicht|kein(?:e|en|er|es)?|minus)\b/.test(normalized)) {
    return 'noch_nicht_richtig';
  }
  const amounts = normalized.match(/[-+−]?\d+(?:[.,]\d+)?/g) ?? [];
  const knownValues = new Set([0, 4, 3000, 12000]);
  const plausible = amounts.every(value => knownValues.has(Number(value.replace(',', '.'))));
  // For this fixed demo, score only an unambiguous result. Allow a simple sentence
  // or a calculation with the given values, as long as it ends in the result.
  return plausible && Number(amounts.at(-1)?.replace(',', '.')) === 3000
    ? 'richtig' : 'noch_nicht_richtig';
}

export function createState() {
  return { attempts: new Map(), events: new Map() };
}

export function createMcpServer({ attempts, events }) {
  const server = new McpServer({ name: 'tk-private-mcp-prototype', version: '0.1.0' });

  server.registerTool('tk_status', {
    description: 'Zeigt den Status des synthetischen TK-Prototyps.',
    inputSchema: empty, annotations: readOnly
  }, () => result({ status: 'bereit', modus: 'synthetisch', speicher: 'fluechtig' }));

  server.registerTool('tk_testfrage_abrufen', {
    description: 'Eröffnet einen Testversuch und liefert eine Rechnungswesenfrage. Stelle sie mündlich und warte auf die Antwort.',
    inputSchema: empty,
    annotations: { ...write, idempotentHint: false }
  }, () => {
    if (attempts.size >= 1000) return error('Das Versuchslimit dieser Testinstanz ist erreicht.');
    const versuchId = randomUUID();
    attempts.set(versuchId, {});
    return result({ ...question, versuchId });
  });

  server.registerTool('tk_testantwort_bewerten', {
    description: 'Bewertet die tatsächlich gegebene Antwort eines Testversuchs und gibt danach die Musterlösung aus.',
    inputSchema: z.strictObject({ versuchId: id, antwort: z.string().trim().min(1).max(1000) }),
    annotations: write
  }, ({ versuchId, antwort }) => {
    const attempt = attempts.get(versuchId);
    if (!attempt) return error('Unbekannter Testversuch.');
    const digest = createHash('sha256').update(antwort).digest('hex');
    if (attempt.digest && attempt.digest !== digest) return error('Dieser Versuch wurde bereits bewertet.');
    attempt.digest = digest;
    attempt.bewertung = evaluate(antwort);
    return result({ versuchId, bewertung: attempt.bewertung, musterloesung: solution });
  });

  server.registerTool('tk_testlernstand_speichern', {
    description: 'Speichert nach ausdrücklicher Nutzerfreigabe genau ein synthetisches Lernereignis für einen bewerteten Versuch.',
    inputSchema: z.strictObject({ versuchId: id, freigabe: z.literal(true) }),
    annotations: write
  }, ({ versuchId }) => {
    const attempt = attempts.get(versuchId);
    if (!attempt?.bewertung) return error('Vor dem Speichern muss eine Antwort bewertet sein.');
    const existing = events.get(versuchId);
    if (existing) return result({ neu: false, ereignis: existing });
    const event = {
      id: versuchId,
      frageId: question.frageId,
      fach: question.fach,
      bewertung: attempt.bewertung,
      gespeichertAm: new Date().toISOString()
    };
    events.set(versuchId, event);
    return result({ neu: true, ereignis: event });
  });

  server.registerTool('tk_testlernstand_lesen', {
    description: 'Liest die Anzahl und bis zu 20 der zuletzt gespeicherten synthetischen Test-Lernereignisse.',
    inputSchema: empty, annotations: readOnly
  }, () => result({ anzahl: events.size, ereignisse: Array.from(events.values()).slice(-20).reverse() }));

  return server;
}
