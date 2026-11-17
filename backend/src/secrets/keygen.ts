import fs from "node:fs";
import path from "node:path";

import { generateRegistryDocument, KEY_ID_RE } from "./registry.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const output = option(process.argv.slice(2), "--output");
const id = option(process.argv.slice(2), "--id");
if (!output || !id || !path.isAbsolute(output) || !KEY_ID_RE.test(id)) {
  throw new Error("usage: secrets:keygen --output /protected/path/keys.json --id key-1");
}
if (fs.existsSync(output)) throw new Error("refusing to overwrite an existing key registry");
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const fd = fs.openSync(output, "wx", 0o600);
try {
  fs.writeFileSync(fd, generateRegistryDocument(id), "utf8");
  fs.fsyncSync(fd);
} finally { fs.closeSync(fd); }
fs.chmodSync(output, 0o600);
process.stdout.write(`created protected key registry ${output} with key id ${id}\n`);
