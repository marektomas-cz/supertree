import fs from 'node:fs';
import path from 'node:path';

const readJson = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
};

const readCargoVersion = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const headerMatch = raw.match(/^\s*\[package\]\s*$/m);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error(`Missing [package] section in ${filePath}`);
  }
  const afterHeader = raw.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderIndex = afterHeader.search(/^\s*\[[^\]]+\]\s*$/m);
  const packageBlock =
    nextHeaderIndex === -1 ? afterHeader : afterHeader.slice(0, nextHeaderIndex);
  const match = packageBlock.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Missing version in ${filePath}`);
  }
  return match[1];
};

const root = process.cwd();
const versions = {
  'package.json': readJson(path.join(root, 'package.json')).version,
  'sidecar/package.json': readJson(path.join(root, 'sidecar/package.json')).version,
  'src-tauri/Cargo.toml': readCargoVersion(path.join(root, 'src-tauri/Cargo.toml')),
  'src-tauri/tauri.conf.json': readJson(path.join(root, 'src-tauri/tauri.conf.json')).version,
};

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error('Version mismatch detected:');
  for (const [file, version] of Object.entries(versions)) {
    console.error(`- ${file}: ${version}`);
  }
  process.exit(1);
}

console.log(`All versions match: ${[...unique][0]}`);
