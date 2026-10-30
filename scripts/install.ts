import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const config = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode")
const plugins = path.join(config, "plugins")
mkdirSync(plugins, { recursive: true })
const link = path.join(plugins, "progress-pin.ts")
const entry = path.join(source, "src", "index.ts")
if (existsSync(link)) {
  if (!lstatSync(link).isSymbolicLink() || path.resolve(path.dirname(link), readlinkSync(link)) !== entry) {
    throw new Error(`Refusing to overwrite another file: ${link}`)
  }
} else symlinkSync(entry, link)
const cliFile = path.join(config, "cli.json")
const cli = existsSync(cliFile) ? JSON.parse(readFileSync(cliFile, "utf8")) as Record<string, unknown> : {}
const previous = Array.isArray(cli.plugins) ? cli.plugins : []
// This plugin owns both agent/task OSC state and the pinned panel, avoiding two
// terminal writers racing. No third-party package files or credentials are deleted.
cli.plugins = [...previous.filter(p => p !== "opencode-terminal-progress" && (typeof p !== "string" || !p.startsWith("/") || path.resolve(p) !== source)), source]
cli.$schema ??= "https://opencode.ai/v2/cli.json"
const pending = `${cliFile}.progress-pin.pending`
writeFileSync(pending, JSON.stringify(cli, null, 2) + "\n", { mode: 0o600 })
renameSync(pending, cliFile)
console.log(`Server: ${link} -> ${entry}`)
console.log(`TUI: ${source} in ${cliFile}`)
console.log("Open a new OpenCode terminal client. Backend changes are picked up by the plugin watcher.")
