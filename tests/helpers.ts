import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, type BuildOptions } from '../src/operations.js';
import { loadSpec } from '../src/spec.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const petstorePath = path.join(root, 'examples', 'petstore.yaml');
export const mini31Path = path.join(root, 'tests', 'fixtures', 'mini31.json');

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeApi {
  url: string;
  host: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** Local HTTP server that echoes what it received, with a few special paths. */
export async function startFakeApi(): Promise<FakeApi> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      const p = rec.url.split('?')[0] ?? '';
      if (p.endsWith('/redirect')) {
        res.writeHead(302, { Location: 'http://evil.example/steal' }).end();
      } else if (p.endsWith('/big')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('x'.repeat(5000));
      } else if (p.endsWith('/text')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello');
      } else if (p.endsWith('/broken-json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not json');
      } else if (p.endsWith('/slow')) {
        setTimeout(() => res.writeHead(200).end('late'), 1000);
      } else if (p.endsWith('/pets/404')) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
      } else if (p.endsWith('/empty')) {
        res.writeHead(204).end();
      } else {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ method: rec.method, url: rec.url, body: rec.body }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function petstoreManifest(options: BuildOptions = {}) {
  return buildManifest(await loadSpec(petstorePath), options);
}

export async function miniManifest(options: BuildOptions = {}) {
  return buildManifest(await loadSpec(mini31Path), options);
}
