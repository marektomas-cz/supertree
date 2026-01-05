import fs from 'node:fs';
import path from 'node:path';

const readJson = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
};

const readCargoVersion = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^version\s*=\s*\"([^\"]+)\"/m);
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
