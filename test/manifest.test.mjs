/**
 * Manifest and packaging invariants.
 *
 * These are the checks that catch a rename, which is the operation most likely
 * to break a plugin silently: the Host half keeps working while the Client half
 * stops registering, so the symptom is "the panel disappeared" with no error.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJson } from './harness.mjs'

export async function run({ check, equal, suite }) {
  suite('manifest')
  const pkg = readJson('package.json')

  // 1. Every export target must exist. A typo here is invisible until load.
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || target.includes('*')) continue
    check(`exports["${key}"] -> ${target}`, existsSync(join(ROOT, target)))
  }

  // 2. Every published file must exist, or the tarball ships broken.
  for (const entry of pkg.files ?? []) {
    check(`files entry ${entry}`, existsSync(join(ROOT, entry)))
  }

  // 3. The loader row must name this package, or the entry cannot resolve.
  const patch = (await import('node:fs')).readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rowName = /name:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(patch)?.[1] ?? ''
  equal('cordis.patch.yml row name matches package name', rowName, pkg.name)

  // 4. The Client bundle's declared module id must match the package name. The
  //    boot graph keys the module by package name, so drift here means the
  //    sidebar icon and panel silently never register.
  const client = (await import('node:fs')).readFileSync(join(ROOT, 'client.js'), 'utf8')
  const declared = /__ModuleLoader__\.load\(\{[\s\S]{0,200}?id:\s*'([^']+)'/.exec(client)?.[1] ?? ''
  equal('client.js module id matches package name', declared, pkg.name)

  // 5. The `dsh.client` half must be declared, or nothing is ever served.
  check('dsh.client declared', pkg.dsh?.client?.platform === 'web')
  check('dsh.bundle.patch declared', typeof pkg.dsh?.bundle?.patch === 'string')
  check('client is injected for the sidebar', (pkg.dsh?.client?.inject ?? []).some((name) => name.includes('sidebar')))

  // 6. The Host entry must export an apply() the Loader can call.
  const host = await import(new URL('../monitor.js', import.meta.url).href)
  check('monitor.js exports apply()', typeof host.apply === 'function')
  check('monitor.js exports a config schema or nothing', host.Config === undefined || typeof host.Config === 'object')
}
