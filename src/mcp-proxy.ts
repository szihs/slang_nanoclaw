/**
 * MCP Server Proxy for NanoClaw.
 * Runs MCP servers on the host and exposes them via SSE so containers
 * can connect without needing tokens or the server code mounted.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { MCP_PROXY_PORT } from './config.js';

const MCP_TOKEN_VARS = [
  'GITHUB_ACCESS_TOKEN',
  'DISCORD_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_TEAM_ID',
  'GITLAB_ACCESS_TOKEN',
  'SLACK_USER_TOKEN',
];

let proxyProcess: ChildProcess | null = null;

export async function startMcpProxy(
  bindHost: string,
): Promise<{ stop: () => void }> {
  const projectRoot = process.cwd();
  const mcpServerDir = path.join(
    projectRoot,
    'container',
    'mcp-servers',
    'slang-mcp',
  );

  if (!fs.existsSync(path.join(mcpServerDir, 'pyproject.toml'))) {
    logger.info(
      'No MCP server found at container/mcp-servers/slang-mcp/, skipping proxy',
    );
    return { stop: () => {} };
  }

  const tokens = readEnvFile(MCP_TOKEN_VARS);
  if (Object.keys(tokens).length === 0) {
    logger.info('No MCP tokens configured in .env, skipping MCP proxy');
    return { stop: () => {} };
  }

  const supergwPath = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    'supergateway',
  );

  proxyProcess = spawn(
    supergwPath,
    [
      '--stdio',
      `uv run --directory ${mcpServerDir} slang-mcp-server`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(MCP_PROXY_PORT),
      '--host',
      bindHost,
    ],
    {
      env: { ...(process.env as Record<string, string>), ...tokens },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  proxyProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) logger.debug({ msg }, 'MCP proxy stderr');
  });

  proxyProcess.on('error', (err) => {
    logger.error({ err }, 'MCP proxy failed to start');
  });

  proxyProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logger.warn({ code }, 'MCP proxy exited unexpectedly');
    }
    proxyProcess = null;
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  logger.info(
    { port: MCP_PROXY_PORT, host: bindHost },
    'MCP proxy started (slang-mcp via SSE)',
  );

  return {
    stop: () => {
      if (proxyProcess) {
        proxyProcess.kill();
        proxyProcess = null;
      }
    },
  };
}
