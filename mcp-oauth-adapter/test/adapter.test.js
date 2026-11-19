import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer as createPrototype } from '../../mcp-prototype/src/server.js';
import { createAdapter, readConfig } from '../server.js';

const issuer = 'https://tk-test.auth0.com/';
const resource = 'https://tk-test.example/mcp';
const subject = 'auth0|synthetic-user';
const clientId = 'test-client';
const secret = randomBytes(32).toString('hex');
const environment = {
  TK_OAUTH_ISSUER: issuer, TK_OAUTH_RESOURCE: resource, TK_OAUTH_SUBJECT: subject,
  TK_OAUTH_CLIENT_ID: clientId, TK_MCP_TOKEN: secret
};
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'test' };
const sign = (claims = {}, key = keys.privateKey, typ = 'at+jwt') => new SignJWT({
  iss: issuer, aud: resource, sub: subject, client_id: clientId,
  iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString('hex'),
  exp: Math.floor(Date.now() / 1000) + 300, scope: 'tk:read tk:write', ...claims
}).setProtectedHeader({ alg: 'RS256', kid: 'test', typ }).sign(key);

async function start(t, server) {
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t) {
  const upstream = await start(t, createPrototype(secret)) + '/mcp';
  return start(t, createAdapter(readConfig(environment), {
    upstream,
    jwksFetch: async url => {
      assert.equal(String(url), issuer + '.well-known/jwks.json');
      return Response.json({ keys: [jwk] });
    }
  }));
}

function rpc(url, token, method, params) {
  return fetch(url + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: 'Bearer ' + token })
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
}

test('Konfiguration fehlt oder ist unsicher', () => {
  assert.throws(() => readConfig({}), /TK_OAUTH_ISSUER/);
  assert.throws(() => readConfig({ ...environment, TK_OAUTH_RESOURCE: 'http://example.test/mcp' }), /TK_OAUTH_RESOURCE/);
  assert.throws(() => readConfig({ ...environment, TK_OAUTH_SUBJECT: 'test@example.test' }), /TK_OAUTH_SUBJECT/);
});

test('PRMD, Challenge und Ablehnung ungültiger Identitäten', async t => {
  const url = await fixture(t);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const metadata = await (await fetch(url + path)).json();
    assert.equal(metadata.resource, resource);
    assert.deepEqual(metadata.authorization_servers, [issuer]);
    assert.deepEqual(metadata.scopes_supported, ['tk:read', 'tk:write']);
  }
  const other = await generateKeyPair('RS256');
  for (const token of [
    undefined, secret, await sign({ iss: 'https://other.example/' }),
    await sign({ aud: 'https://other.example/mcp' }), await sign({ exp: 1 }),
    await sign({ exp: undefined }), await sign({ sub: 'auth0|other' }),
    await sign({ client_id: 'wrong-client' }), await sign({ gty: 'client-credentials' }),
    await sign({}, other.privateKey), await sign({}, keys.privateKey, 'JWT'),
    await sign({ iat: Math.floor(Date.now() / 1000) - 3601 })
  ]) {
    const response = await rpc(url, token, 'tools/list');
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate').includes(
      'resource_metadata="' + url + '/.well-known/oauth-protected-resource/mcp"'));
    assert.ok(!(await response.text()).includes(secret));
  }
});

test('Scopes werden beim Aufruf unabhängig von der Tool-Anzeige durchgesetzt', async t => {
  const url = await fixture(t);
  const read = await sign({ scope: 'tk:read' });
  const write = await sign({ scope: 'tk:write' });
  const none = await sign({ scope: 'other' });
  const list = await rpc(url, read, 'tools/list');
  assert.equal(list.status, 200);
  const tools = (await list.json()).result.tools;
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.find(tool => tool.name === 'tk_testlernstand_speichern')._meta.securitySchemes,
    [{ type: 'oauth2', scopes: ['tk:write'] }]);
  assert.equal((await rpc(url, none, 'tools/list')).status, 403);
  for (const name of ['tk_testfrage_abrufen', 'tk_testantwort_bewerten', 'tk_testlernstand_speichern']) {
    assert.equal((await rpc(url, read, 'tools/call', { name })).status, 403);
  }
  assert.equal((await rpc(url, write, 'tools/call', { name: 'tk_status' })).status, 403);
  assert.equal((await rpc(url, write, 'tools/call', { name: 'anderes_tool' })).status, 400);
  assert.equal((await rpc(url, write, 'resources/read', { uri: 'https://example.test' })).status, 400);
  const blockedBatch = await fetch(url + '/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + read, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tk_testlernstand_speichern' } }])
  });
  assert.equal(blockedBatch.status, 400);
});

test('Alle fünf Tools funktionieren gegen den unveränderten Prototyp', async t => {
  const url = await fixture(t);
  const token = await sign();
  const init = await rpc(url, token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' }
  });
  assert.equal(init.status, 200);
  const call = async (name, args = {}) => {
    const response = await rpc(url, token, 'tools/call', { name, arguments: args });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes(secret) && !body.includes(token));
    return JSON.parse(body).result.structuredContent;
  };
  assert.equal((await call('tk_status')).modus, 'synthetisch');
  const q = await call('tk_testfrage_abrufen');
  assert.equal(q.musterloesung, undefined);
  const args = { versuchId: q.versuchId };
  assert.equal((await call('tk_testantwort_bewerten', { ...args, antwort: '3000' })).bewertung, 'richtig');
  await call('tk_testlernstand_speichern', { ...args, freigabe: true });
  await call('tk_testlernstand_speichern', { ...args, freigabe: true });
  assert.equal((await call('tk_testlernstand_lesen')).anzahl, 1);
});
