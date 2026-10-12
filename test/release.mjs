/**
 * Release checklist.
 *
 * `npm test` covers whether the code works. This covers whether it is ready to
 * be *published*, which is a different question: attribution filled in, no
 * placeholder left behind, nothing private in the tree. It is a separate command
 * on purpose — it is expected to fail until the release metadata is decided.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJson } from './harness.mjs'

const blocking = []
const notes = []

const note = (message) => notes.push(message)
const block = (message) => blocking.push(message)

const pkg = readJson('package.json')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

// --- placeholders -----------------------------------------------------------
const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
if (/<COPYRIGHT HOLDER>/.test(licence)) block('LICENSE still says <COPYRIGHT HOLDER> — MIT needs a real copyright holder')

// --- publish metadata -------------------------------------------------------
if (!pkg.repository) block('package.json has no "repository" — a published package should point back at its source')
if (!pkg.author) note('package.json has no "author"')
if (!pkg.homepage) note('package.json has no "homepage"')
if (pkg.private === true) block('package.json is "private": true — npm will refuse to publish it')

// --- docs agree with the manifest -------------------------------------------
const title = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim() ?? ''
if (title !== pkg.name) block(`README title is "${title}" but the package is "${pkg.name}"`)
if (readme.includes('@local/')) block('README still mentions the old @local/ package name')
if (/##\s+Requirements/.test(readme) === false) note('README has no Requirements section')

// --- every declared path exists ---------------------------------------------
// `files` and `exports` are promises about the tarball. A path that has been
// deleted but not un-declared is invisible in a working tree — it only shows up
// as a missing file after someone installs the package. That happened here once
// already, which is why the check exists.
for (const entry of pkg.files ?? []) {
  if (!existsSync(join(ROOT, entry))) block(`package.json "files" declares "${entry}", which does not exist`)
}

// The reverse direction, and the more dangerous one. `dsh.bundle.patch` names the
// file the Loader reads to insert this bundle's row; if `files` omits it, npm
// publishes a tarball that installs cleanly and then does nothing at all. A
// working tree never reveals that — the file is sitting right there.
const declaredFiles = new Set(pkg.files ?? [])
for (const [value, label] of [[pkg.dsh?.bundle?.patch, 'dsh.bundle.patch'], [pkg.icon, 'icon']]) {
  if (typeof value !== 'string') continue
  const relative = value.replace(/^\.\//, '')
  if (!declaredFiles.has(relative)) {
    block(`package.json "files" omits "${relative}" (${label}) — the published package would not work`)
  }
}
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string') continue
  // A glob export may legitimately match nothing yet; a literal one may not.
  if (target.includes('*')) {
    const dir = join(ROOT, target.slice(0, target.indexOf('*')))
    if (!existsSync(dir)) block(`package.json exports "${key}" -> "${target}", but ${target.slice(0, target.indexOf('*'))} does not exist`)
    continue
  }
  if (!existsSync(join(ROOT, target))) block(`package.json exports "${key}" -> "${target}", which does not exist`)
}

// --- nothing private --------------------------------------------------------
// This file is skipped: it contains the patterns themselves, so it would always
// match itself.
const PRIVATE = /C:\\+Users|Administrator|dahskill|Weixin|WeChat|哔哩|Bilibili|xiaogui|\/Users\/[a-z]/i
const SELF = join(ROOT, 'test', 'release.mjs')
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { walk(path); continue }
    if (path === SELF) continue
    if (!/\.(js|mjs|json|yml|md|svg)$/.test(name)) continue
    const text = readFileSync(path, 'utf8')
    const hit = PRIVATE.exec(text)
    if (hit) block(`${path.slice(ROOT.length + 1)} contains what looks like private data: "${hit[0]}"`)
  }
}
walk(ROOT)

// --- the security model is stated, not implied ------------------------------
// The routes are unauthenticated by choice. A choice that is not written down
// reads as an oversight, so the release check insists it is written down.
if (!/## Requirements/.test(readme) || !/not authenticated/.test(readme)) {
  block('README does not state the security model — the routes are unauthenticated and a reader must be told')
}

// --- the tree itself --------------------------------------------------------
const stray = readdirSync(ROOT).filter((name) => /\.bak$|\.tgz$|^\.probe$/.test(name))
if (stray.length > 0) block(`stray files in the package root: ${stray.join(', ')}`)
for (const required of ['LICENSE', '.gitignore', 'README.md']) {
  try { statSync(join(ROOT, required)) } catch { block(`${required} is missing`) }
}

console.log(`\nrelease check for ${pkg.name}@${pkg.version}\n`)
for (const message of blocking) console.log(`  BLOCK  ${message}`)
for (const message of notes) console.log(`  note   ${message}`)
if (blocking.length === 0 && notes.length === 0) console.log('  ready')
console.log(`\n${blocking.length} blocking, ${notes.length} notes`)
process.exit(blocking.length > 0 ? 1 : 0)
