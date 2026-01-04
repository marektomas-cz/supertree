import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ParsedEnv = Record<string, string>;

export const parseEnvString = (envString: string): ParsedEnv => {
  const result: ParsedEnv = {};
  const lines = envString.split('\n');
  let index = 0;
  while (index < lines.length) {
    let line = lines[index].trim();
    if (!line || line.startsWith('#')) {
      index += 1;
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.substring(7).trim();
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) {
      index += 1;
      continue;
    }
    const key = line.substring(0, equalsIndex).trim();
    if (!key) {
      index += 1;
      continue;
    }
    let value = line.substring(equalsIndex + 1).trim();
    if ((value.startsWith('"') || value.startsWith("'")) && value.length > 1) {
      const quote = value[0];
      const findClosingQuote = (text: string) => {
        let escaped = false;
        for (let i = 1; i < text.length; i += 1) {
          const char = text[i];
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === '\\') {
            escaped = true;
            continue;
          }
          if (char === quote) {
            return i;
          }
        }
        return -1;
      };
      let endQuote = findClosingQuote(value);
      while (endQuote === -1 && index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;
        endQuote = findClosingQuote(value);
      }
      if (endQuote !== -1) {
        const extracted = value.substring(1, endQuote);
        const unescaped = extracted.replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\');
        value = unescaped;
      }
    }
    result[key] = value;
    index += 1;
  }
  return result;
};

export const sidecarRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const resolveClaudeCliPath = () => {
  const cliPath = path.join(
    sidecarRoot(),
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js',
  );
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `Claude CLI not found at ${cliPath}. Ensure @anthropic-ai/claude-agent-sdk is installed.`,
    );
  }
  return cliPath;
};

export const resolveCodexBinaryPath = () => {
  const platform = process.platform;
  const arch = process.arch;
  let target: string;
  if (platform === 'win32') {
    target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  } else if (platform === 'darwin') {
    target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else {
    target = arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  }
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const binaryPath = path.join(
    sidecarRoot(),
    'node_modules',
    '@openai',
    'codex-sdk',
    'vendor',
    target,
    'codex',
    binaryName,
  );
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Codex binary not found at ${binaryPath}. Ensure @openai/codex-sdk is installed.`,
    );
  }
  return binaryPath;
};
