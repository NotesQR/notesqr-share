#!/usr/bin/env node
/**
 * NotesQR MCP server — WebRTC P2P send/recv (both peers must stay online).
 * Tools wrap cli/notesqr.mjs send|recv.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectSendEntries } from '../cli/lib/paths.mjs';
import {
  assertSafeOutputDir,
  isSecretPath,
  mcpRoots,
  resolveLicensePath,
  resolveReadablePath,
} from '../cli/lib/mcp-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'notesqr.mjs');

function runCli(args, { timeoutMs = 0, password = null } = {}) {
  return new Promise((resolve) => {
    // Room password travels via env (not argv, which is visible in the process list).
    const env = { ...process.env, NOTESQR_MCP: '1', NOTESQR_SOURCE: 'mcp' };
    delete env.NOTESQR_PASSWORD;
    if (password) env.NOTESQR_PASSWORD = password;
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          code: -1,
          stdout,
          stderr: stderr + `\n[timeout after ${timeoutMs}ms]`,
        });
      }, timeoutMs);
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// One neutral informational line; no instructions aimed at the host agent.
const SUPPORT = '\n\nSupport NotesQR: https://notesqr.com/donate';

function toolError(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

/**
 * Resolve send paths inside NOTESQR_MCP_ROOTS and refuse secret locations,
 * including anything a folder would pull in. Nothing is read on refusal.
 */
function resolveSendPaths(paths, roots) {
  const resolved = paths.map((p) => resolveReadablePath(p, roots));
  for (const entry of collectSendEntries(resolved)) {
    if (isSecretPath(entry.abs)) {
      throw new Error(`refusing to send a sensitive file: ${entry.abs}`);
    }
  }
  return resolved;
}

const server = new Server(
  { name: 'notesqr-share', version: '2.0.1' },
  {
    capabilities: { tools: {} },
    instructions:
      'NotesQR is free and donation-supported (https://notesqr.com/donate). Premium custom room names are bought only on the web (https://notesqr.com/premium); CLI/MCP only import an existing .nql license. File access is limited to NOTESQR_MCP_ROOTS (default: the server working directory).',
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notesqr_p2p_send',
      description:
        'Host a NotesQR WebRTC P2P room and offer local files and/or folders (directories are walked recursively; peers see share-relative paths only). Prints share URL. Process stays online until transfer completes (--once). Receiver must open the URL or use notesqr_p2p_recv while this runs. Bytes do not stay on NotesQR servers.',
      inputSchema: {
        type: 'object',
        properties: {
          file_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Absolute paths to files and/or folders to send (must be inside NOTESQR_MCP_ROOTS; default the server working directory)',
          },
          password: { type: 'string' },
          name: { type: 'string', description: 'Display name' },
          room: {
            type: 'string',
            description:
              'Optional room id (Premium custom name or random-style). Default: imported Premium room, else random.',
          },
          license_path: {
            type: 'string',
            description:
              'Optional path to a Premium .nql license already purchased on https://notesqr.com/premium (import before send; same as notesqr license import).',
          },
          random_room: {
            type: 'boolean',
            description: 'Force a random room even if a Premium license is imported',
          },
          wait_ms: {
            type: 'number',
            description: 'Max wait for at least one full transfer (default 300000)',
          },
        },
        required: ['file_paths'],
      },
    },
    {
      name: 'notesqr_p2p_recv',
      description:
        'Join a NotesQR WebRTC room and download files/folders while the sender is online (folder trees are recreated under output_dir).',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Room id (abc-defg-hij or Premium name) or full URL' },
          output_dir: {
            type: 'string',
            description: 'Folder to save into (not / or your home directory). Existing files are never overwritten.',
          },
          password: { type: 'string' },
          file: { type: 'string', description: 'Optional single file name/id' },
        },
        required: ['room', 'output_dir'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};

  if (name === 'notesqr_p2p_send') {
    const paths = Array.isArray(a.file_paths) ? a.file_paths.map(String) : [];
    if (!paths.length) {
      return toolError('file_paths required');
    }
    const roots = mcpRoots();
    let sendPaths;
    let licensePath = null;
    try {
      sendPaths = resolveSendPaths(paths, roots);
      if (a.license_path) licensePath = resolveLicensePath(String(a.license_path), roots);
    } catch (err) {
      return toolError(err?.message || String(err));
    }
    if (licensePath) {
      const imp = await runCli(['license', 'import', '--', licensePath], {
        timeoutMs: 60_000,
      });
      if (imp.code !== 0) {
        return toolError((imp.stdout || imp.stderr || 'license import failed') + SUPPORT);
      }
    }
    const cliArgs = ['send', '--once'];
    if (a.name) cliArgs.push('--name', String(a.name));
    if (a.room) cliArgs.push('--room', String(a.room));
    if (a.random_room) cliArgs.push('--random-room');
    cliArgs.push('--', ...sendPaths);
    const wait = Number(a.wait_ms) > 0 ? Number(a.wait_ms) : 300_000;
    const res = await runCli(cliArgs, {
      timeoutMs: wait,
      password: a.password ? String(a.password) : null,
    });
    const text = (res.stdout || res.stderr) + SUPPORT;
    return {
      content: [{ type: 'text', text }],
      isError: res.code !== 0,
    };
  }

  if (name === 'notesqr_p2p_recv') {
    let outDir;
    try {
      outDir = assertSafeOutputDir(a.output_dir);
    } catch (err) {
      return toolError(err?.message || String(err));
    }
    if (!a.room) return toolError('room required');
    const cliArgs = ['recv', '-o', outDir];
    if (a.file) cliArgs.push('--file', String(a.file));
    cliArgs.push('--', String(a.room));
    const res = await runCli(cliArgs, {
      timeoutMs: 300_000,
      password: a.password ? String(a.password) : null,
    });
    const text = (res.stdout || res.stderr) + SUPPORT;
    return {
      content: [{ type: 'text', text }],
      isError: res.code !== 0,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
