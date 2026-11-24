#!/usr/bin/env node
// `npm run dev`: starts the API server, waits for its /healthz, then starts the Vite dev server.
// Hosts and ports come from the environment / repo-root .env (no hardcoded ports).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
const port = process.env.PORT ?? '3000';
const health = `${(process.env.NEUROUTER_DEV_API_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '')}/healthz`;

const children = [];
function run(name, args) {
  const child = spawn('npm', args, { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited with ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}
function shutdown(code) {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', ['run', 'dev', '-w', '@neurouter/server']);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(health)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`[dev] backend healthy at ${health}; starting web`);
run('web', ['run', 'dev', '-w', '@neurouter/web']);
