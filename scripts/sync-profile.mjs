#!/usr/bin/env node
/**
 * Sync this package into an installed DSH profile.
 *
 * WHY THIS EXISTS: an installed copy can carry TWO entry layouts — the
 * package.json `main`/`exports` target (`lib/index.js`, `lib/client.js`) and
 * root aliases (`index.js`, `client.js`). The host loader resolves the bundle
 * name to the package directory and can prefer the ROOT `index.js` when one is
 * present. A root alias left behind by an older install (or by a careless
 * `cp lib/index.js <pkg>/`) therefore hijacks the host half: the profile keeps
 * running the stale host code after a restart while `lib/` looks up to date.
 *
 * Both layouts are written from the same bytes so neither resolution rule can
 * select a different version, and the profile's two copies (the workspace
 * package and the pnpm materialization under node_modules) stay identical.
 *
 * Usage: node scripts/sync-profile.mjs [<profile-dir> ...]
 *        (defaults to $DSH_HOME/profiles/web)
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = [
  ['lib/index.js', 'lib/index.js'],
  ['lib/client.js', 'lib/client.js'],
  // Root aliases: keep byte-identical to lib/, never a stale snapshot.
  ['lib/index.js', 'index.js'],
  ['lib/client.js', 'client.js'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['README.zh.md', 'README.zh.md'],
  ['PROFILE_EVIDENCE.md', 'PROFILE_EVIDENCE.md'],
  ['test/delivery.mjs', 'test/delivery.mjs'],
  ['test/client.mjs', 'test/client.mjs'],
  ['scripts/sync-profile.mjs', 'scripts/sync-profile.mjs'],
]

const profiles = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [join(process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), 'profiles', 'web')]

let failures = 0
for (const profile of profiles) {
  if (!existsSync(profile)) {
    console.error(`sync-profile: no such profile directory: ${profile}`)
    failures += 1
    continue
  }
  const targets = [
    join(profile, 'packages', 'dsh-timer-scheduler-ui'),
    // pnpm materializes a `file:` dependency here; both may be loaded.
    join(profile, 'node_modules', 'dsh-timer-scheduler-ui'),
  ]
  for (const target of targets) {
    if (!existsSync(target)) continue
    mkdirSync(join(target, 'lib'), { recursive: true })
    mkdirSync(join(target, 'test'), { recursive: true })
    mkdirSync(join(target, 'scripts'), { recursive: true })
    for (const [src, dst] of FILES) {
      const from = join(packageRoot, src)
      const to = join(target, dst)
      // Running this from inside an installed copy would self-copy; skip it.
      if (resolve(from) === resolve(to)) continue
      copyFileSync(from, to)
    }
    console.log(`sync-profile: synced ${target}`)
  }
}
if (failures > 0) process.exit(1)
console.log('sync-profile: done — restart DSH for the host half to pick the new code up')
