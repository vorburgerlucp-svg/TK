import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../src/server.js';

const token = randomBytes(32).toString('hex');
const headers = { Authorization: 'Bearer ' + token };

async function start(t) {
  const server = createServer(token).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return new URL('http://127.0.0.1:' + server.address().port + '/mcp');
}

async function connect(t, url) {
  const client = new Client({ name: 'tk-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('Ein starkes Token ist beim Start zwingend', () => {
  for (const invalid of [undefined, '', 'kurz']) {
    assert.throws(() => createServer(invalid), /TK_MCP_TOKEN/);
  }
});

test('HTTP schützt MCP und begrenzt Herkunft, Methode und Body', async t => {
  const url = await start(t);
  for (const authorization of [undefined, 'Bearer ' + '0'.repeat(64)]) {
    const response = await fetch(url, {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {}
    });
    assert.equal(response.status, 401);
  }
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { ...headers, Origin: 'https://example.test' }
  })).status, 403);
  assert.equal((await fetch(url, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify('x'.repeat(17_000))
  })).status, 413);
});

test('Mündlicher MCP-Ablauf, Freigabe und konkurrierende Wiederholungen', async t => {
  const url = await start(t);
  const client = await connect(t, url);
  const secondClient = await connect(t, url);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'tk_status', 'tk_testantwort_bewerten', 'tk_testfrage_abrufen',
    'tk_testlernstand_lesen', 'tk_testlernstand_speichern'
  ]);
  assert.equal(tools.find(tool => tool.name === 'tk_testlernstand_speichern').annotations.readOnlyHint, false);
  assert.equal((await call('tk_status')).structuredContent.modus, 'synthetisch');
  const question = await call('tk_testfrage_abrufen');
  const { versuchId, frageId } = question.structuredContent;
  assert.deepEqual(Object.keys(question.structuredContent).sort(), ['fach', 'frage', 'frageId', 'versuchId']);
  assert.doesNotMatch(JSON.stringify(question), /3[’']?000|musterloesung/i);
  const read = () => call('tk_testlernstand_lesen');
  assert.equal((await read()).structuredContent.anzahl, 0);
  const save = (freigabe, id = versuchId) =>
    call('tk_testlernstand_speichern', { versuchId: id, freigabe });
  assert.equal((await save(true)).isError, true);
  const grade = (antwort, id = versuchId) =>
    call('tk_testantwort_bewerten', { versuchId: id, antwort });
  for (const invalid of [await grade('   '), await grade('x'.repeat(1001)), await grade('3000', randomUUID())]) {
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /musterloesung|3’000/i);
  }
  const result = await grade('Der Abschreibungsaufwand beträgt CHF 3’000 pro Jahr.');
  assert.equal(result.structuredContent.bewertung, 'richtig');
  assert.match(result.structuredContent.musterloesung, /3’000/);
  assert.deepEqual((await grade('Der Abschreibungsaufwand beträgt CHF 3’000 pro Jahr.')).structuredContent, result.structuredContent);
  assert.equal((await grade('1000')).isError, true);
  assert.equal((await save(false)).isError, true);
  assert.equal((await read()).structuredContent.anzahl, 0);
  const writes = await Promise.all([
    save(true),
    secondClient.callTool({
      name: 'tk_testlernstand_speichern', arguments: { versuchId, freigabe: true }
    })
  ]);
  assert.equal(writes[0].structuredContent.ereignis.id, writes[1].structuredContent.ereignis.id);
  assert.equal(writes.filter(write => write.structuredContent.neu).length, 1);
  const progress = (await read()).structuredContent;
  assert.equal(progress.anzahl, 1);
  assert.equal(progress.ereignisse[0].frageId, frageId);
  assert.doesNotMatch(JSON.stringify(progress), /Abschreibungsaufwand|musterloesung/);
  const second = (await call('tk_testfrage_abrufen')).structuredContent;
  assert.equal((await grade('30000', second.versuchId)).structuredContent.bewertung, 'noch_nicht_richtig');
});

test('Bewertung erkennt Schweizer Zahlenschreibweise und offensichtliche Verneinung', async t => {
  const client = await connect(t, await start(t));
  for (const [antwort, bewertung] of [
    ['CHF 12’000 / 4 = CHF 3’000', 'richtig'],
    ['Drei Tausend Franken', 'richtig'],
    ['Die Abschreibung beträgt nicht CHF 3’000.', 'noch_nicht_richtig'],
    ['Minus 3000 Franken.', 'noch_nicht_richtig']
  ]) {
    const question = await client.callTool({ name: 'tk_testfrage_abrufen', arguments: {} });
    const { versuchId } = question.structuredContent;
    const result = await client.callTool({
      name: 'tk_testantwort_bewerten', arguments: { versuchId, antwort }
    });
    assert.equal(result.structuredContent.bewertung, bewertung, antwort);
  }
});
