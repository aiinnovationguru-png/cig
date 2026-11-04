import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('tutti i comandi invocati dal frontend sono registrati nel backend', () => {
  const frontend = read('src/api.ts') + '\n' + read('src/lib/api-anything.ts');
  const calls = [...frontend.matchAll(/\binvoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.ok(calls.length > 30, 'nessun comando frontend rilevato');
  const bootstrap = read('src-tauri/src/lib.rs');
  const registered = new Set([...bootstrap.matchAll(/(?:commands|api_anything)::(\w+),/g)].map((match) => match[1]));
  const definitions = read('src-tauri/src/commands.rs') + '\n' + read('src-tauri/src/api_anything.rs');
  for (const command of calls) {
    assert.ok(registered.has(command), `comando non registrato: ${command}`);
    assert.match(definitions, new RegExp(`pub (?:async )?fn ${command}\\s*\\(`));
  }
});

test('la configurazione desktop usa i percorsi e la porta del frontend', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(config.build.frontendDist, '../dist');
  assert.equal(new URL(config.build.devUrl).port, '1420');
  assert.ok(pkg.scripts.dev);
  assert.ok(pkg.scripts.build);
  assert.equal(config.identifier, 'it.cig.intelligence');
});
