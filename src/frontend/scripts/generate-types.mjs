// Generate TypeScript types from the authoritative JSON Schema bundle (itself generated from the
// backend pydantic models). Usage: node scripts/generate-types.mjs [--check]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';

const schemaPath = new URL('../../contracts/schema/oxford-hack.schema.json', import.meta.url);
const typesPath = new URL('../src/contracts/generated/types.ts', import.meta.url);
const schemaCopy = new URL('../src/contracts/generated/schema.json', import.meta.url);

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
// Drop property-level titles so fields get inline types instead of aliases like `Bookmarkid`.
function stripTitles(node, isDef) {
  if (Array.isArray(node)) return node.map((n) => stripTitles(n, false));
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'title' && !isDef) continue;
    if (k === '$defs') {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, d]) => [name, stripTitles(d, true)]));
    } else {
      out[k] = stripTitles(v, false);
    }
  }
  return out;
}
const root = stripTitles({ title: 'WireMessage', anyOf: schema.anyOf, $defs: schema.$defs }, true);
let ts = await compile(root, 'WireMessage', {
  bannerComment:
    '/* GENERATED from contracts/schema/oxford-hack.schema.json by scripts/generate-types.mjs. Do not edit. */',
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  strictIndexSignatures: true,
  unreachableDefinitions: true,
  format: true,
  style: { singleQuote: true, printWidth: 110 },
});
const types = Object.keys(schema['x-messages']);
ts += `\nexport const SCHEMA_VERSION = ${JSON.stringify(schema['x-schemaVersion'])};\n`;
ts += `export const MESSAGE_TYPES = ${JSON.stringify(types)} as const;\n`;
ts += 'export type MessageType = (typeof MESSAGE_TYPES)[number];\n';

if (process.argv.includes('--check')) {
  const same =
    existsSync(typesPath) &&
    readFileSync(typesPath, 'utf8') === ts &&
    existsSync(schemaCopy) &&
    readFileSync(schemaCopy, 'utf8') === readFileSync(schemaPath, 'utf8');
  if (!same) {
    console.error('frontend contract types are out of date: run `npm run contracts:generate`');
    process.exit(1);
  }
  console.log('frontend contract types up to date');
} else {
  writeFileSync(typesPath, ts);
  copyFileSync(schemaPath, schemaCopy);
  console.log('wrote src/contracts/generated/types.ts and schema.json');
}
