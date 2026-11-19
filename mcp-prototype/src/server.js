import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, createState } from './tools.js';

const maxBodyBytes = 16 * 1024;
const loopback = '127.0.0.1';

function reply(response, status, message, headers = {}) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

function authorized(actual, expected) {
  if (typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request) {
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
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('TK_MCP_TOKEN muss aus 64 Hex-Zeichen bestehen.');
  }
  const expected = Buffer.from('Bearer ' + token);
  const state = createState();

  return createHttpServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');

    try {
      const host = request.headers.host;
      if (host !== loopback + ':' + request.socket.localPort || request.headers.origin !== undefined) {
        return reply(response, 403, 'Herkunft nicht zugelassen.');
      }
      if (request.url !== '/mcp') return reply(response, 404, 'Pfad unbekannt.');
      if (!authorized(request.headers.authorization, expected)) {
        return reply(response, 401, 'Authentifizierung erforderlich.', { 'WWW-Authenticate': 'Bearer' });
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        // Stateless Streamable HTTP offers POST only. The SDK client may probe SSE.
        response.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      if (request.method !== 'POST') return reply(response, 405, 'Methode nicht erlaubt.', { Allow: 'POST' });
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reply(response, 415, 'JSON erforderlich.');
      }
      if (Number(request.headers['content-length']) > maxBodyBytes) {
        return reply(response, 413, 'Anfrage zu gross.', { Connection: 'close' });
      }

      const raw = await readBody(request);
      if (raw === null) return reply(response, 413, 'Anfrage zu gross.', { Connection: 'close' });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(response, 400, 'Ungültiges JSON.');
      }

      const mcp = createMcpServer(state);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      response.once('close', () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) reply(response, 500, 'Interner Fehler.');
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TK_MCP_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TK_MCP_PORT ist ungültig.');
  const server = createServer(process.env.TK_MCP_TOKEN);
  server.listen(port, loopback, () => console.log('TK MCP lokal unter http://' + loopback + ':' + port + '/mcp'));
}
