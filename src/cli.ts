#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import pc from 'picocolors'
import { greet } from './greet.ts'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const args = process.argv.slice(2)

if (args.includes('--version')) {
  console.log(version)
} else {
  console.log(pc.green(greet(args[0] ?? 'world')))
}
