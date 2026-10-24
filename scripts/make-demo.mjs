// Render docs/demo.svg from the real output of the built CLI and the example script.
// Usage: npm run demo
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(args) {
  return execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n').trimEnd();
}

const blocks = [
  ['$ openapi-to-mcp list examples/petstore.yaml', run(['dist/bin.js', 'list', 'examples/petstore.yaml'])],
  ['$ node examples/call-tool.mjs', run(['examples/call-tool.mjs'])],
];

const lines = [];
for (const [cmd, out] of blocks) {
  if (lines.length > 0) {
    lines.push({ text: '', kind: 'out' });
  }
  lines.push({ text: cmd, kind: 'cmd' });
  for (const line of out.split('\n')) {
    lines.push({ text: line, kind: line.startsWith('>') ? 'call' : 'out' });
  }
}

const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const width = Math.max(760, ...lines.map((l) => l.text.length * 8.5 + 64));
const height = 90 + lines.length * 21;
const colors = { cmd: '#a5b4fc', call: '#fbbf24', out: '#d1d5db' };
const rows = lines
  .map((l, i) => `    <text x="32" y="${86 + i * 21}" fill="${colors[l.kind]}">${esc(l.text)}</text>`)
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">openapi-to-mcp turns an OpenAPI spec into MCP tools</title>
  <desc id="desc">Real output of the list command and of examples/call-tool.mjs, which serves the petstore spec and calls the getPet tool against a local fake API.</desc>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="16" fill="#0d1117" stroke="#30363d"/>
  <path d="M17 1h${width - 34}a16 16 0 0 1 16 16v33H1V17A16 16 0 0 1 17 1Z" fill="#161b22"/>
  <circle cx="25" cy="25" r="6" fill="#ff5f57"/>
  <circle cx="45" cy="25" r="6" fill="#febc2e"/>
  <circle cx="65" cy="25" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="30" text-anchor="middle" fill="#8b949e" font-family="monospace" font-size="13">openapi-to-mcp</text>
  <g font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="14" xml:space="preserve">
${rows}
  </g>
</svg>
`;

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'demo.svg'), svg);
console.log('Generated docs/demo.svg from real CLI output.');
