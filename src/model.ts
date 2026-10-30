import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type Status = "starting" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out"
export type Parser = "auto" | "json" | "regex" | "none"
export interface Progress {
  current?: number
  total?: number | null
  percent?: number | null
  message?: string
  phase?: string
  unit?: string
  status?: "running" | "paused" | "succeeded" | "failed" | "cancelled"
}
export interface Start {
  label: string
  command?: string
  cwd?: string
  parser?: Parser
  pattern?: string
  progress_command?: string
  total?: number
  unit?: string
  timeout?: number
  idle_timeout?: number
  notify?: boolean
  env?: Record<string, string>
}
export interface Task {
  id: string
  sessionID: string
  directory: string
  label: string
  command?: string
  cwd: string
  status: Status
  current?: number
  total?: number | null
  percent?: number | null
  message: string
  phase: string
  unit: string
  created: number
  updated: number
  heartbeat: number
  ended?: number
  pid?: number
  workerPID?: number
  workerStart?: string
  exitCode?: number
  signal?: string
  timeout?: number
  idleTimeout?: number
  timeoutKind?: "maximum" | "idle"
  error?: string
  warning?: string
  runner: "manual" | "systemd" | "detached"
  notified: boolean
  notificationError?: string
  notify: boolean
  version: number
  logPath: string
}
export interface Config extends Start {
  task: Task
  env: Record<string, string>
}
export const terminal = (s: Status) => ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(s)
export function rootFor(directory: string, override?: string) {
  const base = override ?? path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "opencode-progress-pin")
  return path.join(base, createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16))
}
export function newID() { return `pin_${randomUUID().replaceAll("-", "").slice(0, 16)}` }
export function taskDir(root: string, id: string) {
  if (!/^pin_[a-f0-9]{16}$/.test(id)) throw new Error("Invalid task ID")
  return path.join(root, id)
}
export function atomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const pending = `${file}.${process.pid}.${randomUUID()}.pending`
  writeFileSync(pending, JSON.stringify(value), { mode: 0o600 })
  renameSync(pending, file)
}
export function json<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T } catch { return undefined }
}
export function readTask(root: string, id: string) { return json<Task>(path.join(taskDir(root, id), "state.json")) }
export function tasks(root: string): Task[] {
  try {
    return readdirSync(root).filter(id => /^pin_[a-f0-9]{16}$/.test(id))
      .flatMap(id => readTask(root, id) ?? []).sort((a, b) => b.created - a.created)
  } catch { return [] }
}
export function clean(text: string, limit = 500) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit)
}
export function validateProgress(input: unknown): Progress {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Progress must be a JSON object")
  const source = input as Record<string, unknown>
  const value: Progress = {}
  for (const key of ["current", "total", "percent"] as const) {
    const n = source[key]
    if (n === undefined) continue
    if (n === null && key !== "current") { value[key] = null; continue }
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key === "percent" && n > 100)) throw new Error(`Invalid ${key}`)
    value[key] = n
  }
  for (const key of ["message", "phase", "unit"] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== "string") throw new Error(`Invalid ${key}`)
    value[key] = clean(source[key], key === "unit" ? 30 : 500)
  }
  if (source.status !== undefined) {
    if (!["running", "paused", "succeeded", "failed", "cancelled"].includes(String(source.status))) throw new Error("Invalid status")
    value.status = source.status as Progress["status"]
  }
  return value
}
export function apply(task: Task, value: Progress, managed = !!task.command) {
  const { status, ...progress } = value
  Object.assign(task, progress)
  // A measured count is authoritative; a phase can explicitly clear its old total.
  if ("current" in value || "total" in value) {
    task.percent = task.total && task.total > 0 && task.current !== undefined
      ? Math.min(100, Math.max(0, task.current / task.total * 100)) : null
  }
  if (status && (!managed || ["running", "paused"].includes(status))) task.status = status
  if (terminal(task.status)) task.ended = Date.now()
  task.updated = Date.now()
  task.version++
}
export function tail(file: string, lines = 30) {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const size = statSync(file).size
    const buffer = Buffer.alloc(Math.min(size, 65536))
    readSync(fd, buffer, 0, buffer.length, size - buffer.length)
    return buffer.toString("utf8").split(/\r\n|[\r\n]/).slice(-Math.min(200, Math.max(1, lines))).join("\n")
  } catch { return "" } finally { if (fd !== undefined) closeSync(fd) }
}
export function processStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[19] } catch { return undefined }
}
