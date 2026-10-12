/**
 * Test runner.
 *
 * Plain Node, no framework: `node test/run.mjs` must work with nothing installed,
 * because a suite that needs setup is a suite that stops being run.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv[2]

const suites = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => only === undefined || name.includes(only))
  .sort()

let passed = 0
const failures = []

/** Record one assertion. */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`)
    return true
  }
  failures.push(name)
  console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  return false
}

/** Record one assertion that two values are equal. */
function equal(name, actual, expected) {
  return check(name, Object.is(actual, expected), Object.is(actual, expected) ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const context = { check, equal, suite: (title) => console.log(`\n${title}`) }

for (const file of suites) {
  const module = await import(pathToFileURL(join(here, file)).href)
  try {
    await module.run(context)
  } catch (error) {
    failures.push(`${file} threw`)
    console.log(`  FAIL  ${file} threw: ${error.message}`)
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
}

// A machine-readable report, so a caller that cannot capture stdout (a sandbox
// that blocks piped stdio, for instance) can still tell what happened.
if (process.env.DSM_TEST_REPORT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.DSM_TEST_REPORT, JSON.stringify({ passed, failures }))
}

if (failures.length > 0) process.exit(1)
