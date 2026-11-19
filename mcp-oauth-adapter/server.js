import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

const loopback = '127.0.0.1';
const resourceMetadataPath = '/.well-known/oauth-protected-resource';
const allowedTools = new Map([
  ['tk_status', 'tk:read'],
  ['tk_testfrage_abrufen', 'tk:write'],
  ['tk_testantwort_bewerten', 'tk:write'],
  ['tk_testlernstand_speichern', 'tk:write'],
  ['tk_testlernstand_lesen', 'tk:read']
]);
const scopes = ['tk:read', 'tk:write'];
const protocolMethods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
const maxBodyBytes = 16 * 1024;

function httpsUrl(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.href === value && !url.username && !url.password &&
        !url.search && !url.hash && /^[\x21-\x7e]+$/.test(value) && !value.includes('"')) {
      return url;
    }
  } catch {
    // Configuration errors report the variable name only.
  }
  throw new Error(name + ' muss eine kanonische HTTPS-URL sein.');
}

export function readConfig(env) {
  const issuer = httpsUrl(env.TK_OAUTH_ISSUER, 'TK_OAUTH_ISSUER');
  if (issuer.pathname !== '/') throw new Error('TK_OAUTH_ISSUER muss die Auth0-Basis-URL sein.');
  const resource = httpsUrl(env.TK_OAUTH_RESOURCE, 'TK_OAUTH_RESOURCE');
  const subject = env.TK_OAUTH_SUBJECT;
  if (!/^[a-zA-Z0-9_-]+\|[a-zA-Z0-9._@+-]+$/.test(subject ?? '')) {
    throw new Error('TK_OAUTH_SUBJECT muss die feste Auth0-Benutzer-ID sein.');
  }
  const clientId = env.TK_OAUTH_CLIENT_ID;
  if (!/^[a-zA-Z0-9_-]+$/.test(clientId ?? '')) throw new Error('TK_OAUTH_CLIENT_ID fehlt oder ist ungültig.');
  const upstreamToken = env.TK_MCP_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(upstreamToken ?? '')) throw new Error('TK_MCP_TOKEN fehlt oder ist ungültig.');
  const port = Number(env.TK_OAUTH_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8790) {
    throw new Error('TK_OAUTH_PORT ist ungültig oder für den Prototyp reserviert.');
  }
  return { issuer: issuer.href, resource: resource.href, subject, clientId, upstreamToken, port };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createAdapter(config, {
  upstream = 'http://127.0.0.1:8790/mcp',
  jwksFetch
} = {}) {
  const jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer),
    jwksFetch ? { [customFetch]: jwksFetch } : {});
  const metadata = {
    resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: scopes, bearer_methods_supported: ['header']
  };
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.headers.host !== loopback + ':' + request.socket.localPort ||
          request.headers.origin !== undefined) {
        return send(response, 403, { error: 'origin_not_allowed' });
      }
      if (request.method === 'GET' && [resourceMetadataPath, resourceMetadataPath + '/mcp'].includes(request.url)) {
        return send(response, 200, metadata);
      }
      if (request.url !== '/mcp') return send(response, 404, { error: 'not_found' });
      // The tunnel probes this same-origin URL and rewrites it for its HTTPS clients.
      const metadataUrl = 'http://' + loopback + ':' + request.socket.localPort + resourceMetadataPath + '/mcp';
      const challenge = 'Bearer resource_metadata="' + metadataUrl + '"';

      const token = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(request.headers.authorization ?? '')?.[1];
      let claims;
      try {
        if (token) {
          ({ payload: claims } = await jwtVerify(token, jwks, {
            issuer: config.issuer, audience: config.resource, algorithms: ['RS256'],
            typ: 'at+jwt', maxTokenAge: '1h',
            requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'jti', 'client_id']
          }));
        }
      } catch {
        // Never return or log OAuth credentials or verification internals.
      }
      if (!claims || claims.sub !== config.subject || claims.client_id !== config.clientId ||
          claims.gty === 'client-credentials') {
        const header = token ? challenge + ', error="invalid_token"' : challenge;
        return send(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': header });
      }
      if (request.method !== 'POST') return send(response, 405, undefined, { Allow: 'POST' });
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return send(response, 415, { error: 'json_required' });
      }
      if (Number(request.headers['content-length']) > maxBodyBytes) {
        return send(response, 413, { error: 'request_too_large' }, { Connection: 'close' });
      }
      const message = await readJson(request);
      if (message === null) return send(response, 413, { error: 'request_too_large' }, { Connection: 'close' });
      if (message?.jsonrpc !== '2.0' || !protocolMethods.has(message.method) ||
          (message.method !== 'notifications/initialized' &&
           typeof message.id !== 'string' && typeof message.id !== 'number')) {
        return send(response, 400, { error: 'unsupported_mcp_message' });
      }

      const granted = new Set(typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : []);
      const callingTool = message.method === 'tools/call';
      const required = callingTool && allowedTools.get(message.params?.name);
      if (callingTool && !required) return send(response, 400, { error: 'unsupported_tool' });
      if (required ? !granted.has(required) : !scopes.some(scope => granted.has(scope))) {
        const header = challenge + ', error="insufficient_scope"' + (required ? ', scope="' + required + '"' : '');
        return send(response, 403, { error: 'insufficient_scope' }, { 'WWW-Authenticate': header });
      }

      const headers = {
        Authorization: 'Bearer ' + config.upstreamToken,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      };
      if (request.headers['mcp-protocol-version']) {
        headers['MCP-Protocol-Version'] = request.headers['mcp-protocol-version'];
      }
      const result = await fetch(upstream, {
        method: 'POST', headers, body: JSON.stringify(message),
        redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (result.status === 202) return send(response, 202);
      if (result.status !== 200) {
        await result.body?.cancel();
        return send(response, 502, { error: 'prototype_unavailable' });
      }
      const body = await result.json();
      if (message.method === 'tools/list' && Array.isArray(body.result?.tools)) {
        body.result.tools = body.result.tools.filter(tool => allowedTools.has(tool.name)).map(tool => ({
          ...tool,
          _meta: { ...tool._meta, securitySchemes: [{ type: 'oauth2', scopes: [allowedTools.get(tool.name)] }] }
        }));
      }
      return send(response, 200, body);
    } catch {
      if (!response.headersSent) send(response, 502, { error: 'prototype_unavailable' });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig(process.env);
    createAdapter(config).listen(config.port, loopback, () => {
      console.log('OAuth-Adapter lauscht lokal auf ' + loopback + ':' + config.port + '/mcp.');
      console.log('Die reale OAuth-Anmeldung und Tunnel-Verbindung sind separat zu prüfen.');
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
