import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodexResponsesClient } from './codexResponsesClient.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }));
});

describe('Codex Responses client', () => {
  it('does not retry a CodexAPI 500 response', async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'CodexAPI failed' } }));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const client = createCodexResponsesClient({ baseURL: `http://127.0.0.1:${address.port}/v1` });

    await expect(client.create({ model: 'gpt-5.6-terra', input: 'Find Catan.' })).rejects.toThrow();

    expect(attempts).toBe(1);
  });
});
