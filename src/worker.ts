// Dedicated process: owns state and pipes. It survives a plugin/TUI reload.
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { apply, atomic, clean, json, processStart, validateProgress, type Config, type Progress, type Status } from "./model"

const dir = process.argv[2]
const config = json<Config>(path.join(dir, "config.json"))
if (!config) throw new Error("Missing task configuration")
const task = config.task
const stateFile = path.join(dir, "state.json")
task.workerPID = process.pid
task.workerStart = processStart(process.pid)
task.status = "running"
task.version++
task.heartbeat = Date.now()
let lastActivity = Date.now()
let dirty = true
let stopped: Status | undefined
let stopMessage = ""
let child: ChildProcess | undefined
let observer: ChildProcess | undefined
let killTimer: ReturnType<typeof setTimeout> | undefined
let reportStamp = ""
let logSize = 0
let regex: RegExp | undefined
if (config.parser === "regex" && config.pattern) regex = new RegExp(config.pattern)
const save = () => {
  task.heartbeat = Date.now()
  atomic(stateFile, task)
  dirty = false
}
const update = (input: unknown) => {
  try {
    const progress = validateProgress(input)
    apply(task, progress, true)
    lastActivity = Date.now()
    dirty = true
  } catch (error) {
    task.warning = clean(`Invalid progress: ${String(error)}`)
    dirty = true
  }
}
const parse = (raw: string, observerOutput = false) => {
  const line = clean(raw, 16384).trim()
  if (!line) return
  if (line.startsWith("@@progress ")) {
    try { update(JSON.parse(line.slice(11))) } catch { task.warning = "Malformed @@progress JSON"; dirty = true }
    return
  }
  if (observerOutput || config.parser === "json") {
    try { update(JSON.parse(line)) } catch { /* ordinary command output is not progress */ }
    return
  }
  if (config.parser === "none") return
  if (regex) {
    const groups = regex.exec(line)?.groups
    if (!groups) return
    const value: Progress = {}
    for (const k of ["current", "total", "percent"] as const) if (groups[k] !== undefined) value[k] = Number(groups[k])
    for (const k of ["message", "phase", "unit"] as const) if (groups[k] !== undefined) value[k] = groups[k]
    update(value)
    return
  }
  const percent = line.match(/(?:^|[^\d.])(100(?:\.0+)?|\d{1,2}(?:\.\d+)?)\s*%/)
  const count = line.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?![\d.])/)
  if (percent || count) {
    const value: Progress = { message: line.slice(0, 240) }
    if (percent) value.percent = Number(percent[1])
    if (count) { value.current = Number(count[1]); value.total = Number(count[2]) }
    update(value)
  }
}
function log(chunk: Buffer, kind: "stdout" | "stderr" | "observer") {
  if (logSize + chunk.length > 10 * 1024 * 1024) {
    try { renameSync(task.logPath, `${task.logPath}.1`) } catch { /* first write */ }
    logSize = 0
  }
  appendFileSync(task.logPath, chunk, { mode: 0o600 })
  logSize += chunk.length
  if (kind !== "observer") lastActivity = Date.now()
}
function capture(proc: ChildProcess, kind: "command" | "observer") {
  for (const name of ["stdout", "stderr"] as const) {
    let pending = ""
    proc[name]?.setEncoding("utf8")
    proc[name]?.on("data", (text: string) => {
      log(Buffer.from(text), kind === "observer" ? "observer" : name)
      pending += text
      const lines = pending.split(/[\r\n]/)
      pending = lines.pop()!.slice(-16384)
      for (const line of lines) parse(line, kind === "observer" && name === "stdout")
    })
    proc[name]?.on("end", () => { if (pending) parse(pending, kind === "observer" && name === "stdout") })
  }
}
function signal(proc: ChildProcess | undefined, sig: NodeJS.Signals) {
  if (!proc?.pid) return
  try { process.kill(-proc.pid, sig) } catch { /* already exited */ }
}
function stop(reason: Status, message: string) {
  if (stopped) return
  stopped = reason
  stopMessage = message
  task.message = message
  task.updated = Date.now()
  task.version++
  dirty = true
  signal(child, "SIGTERM")
  signal(observer, "SIGTERM")
  killTimer = setTimeout(() => { signal(child, "SIGKILL"); signal(observer, "SIGKILL") }, 3000)
}
function readReport() {
  const file = path.join(dir, "report.json")
  try {
    const raw = readFileSync(file, "utf8")
    if (raw !== reportStamp) { reportStamp = raw; update(JSON.parse(raw)) }
  } catch { /* no report yet, or producer between writes */ }
}
const env = {
  ...config.env,
  OPENCODE_PROGRESS_FILE: path.join(dir, "report.json"),
  OPENCODE_PROGRESS_TASK: task.id,
  PYTHONUNBUFFERED: "1",
}
writeFileSync(task.logPath, "", { mode: 0o600 })
save()
child = spawn(config.env.SHELL || "/bin/sh", ["-c", task.command!], {
  cwd: task.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
})
task.pid = child.pid
save()
capture(child, "command")
if (config.progress_command) {
  observer = spawn(config.env.SHELL || "/bin/sh", ["-c", config.progress_command], {
    cwd: task.cwd, env: { ...env, OPENCODE_PROGRESS_PID: String(child.pid ?? "") },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  capture(observer, "observer")
  observer.on("error", error => { task.warning = `Progress observer: ${clean(error.message)}`; dirty = true })
  observer.on("exit", code => {
    if (code && !stopped) { task.warning = `Progress observer exited ${code}; command still tracked`; dirty = true }
  })
}
process.on("SIGTERM", () => stop("interrupted", "Task runner interrupted"))
process.on("SIGINT", () => stop("cancelled", "Cancelled"))
child.on("error", error => { task.error = clean(error.message); stopMessage = task.error; stopped = "failed" })
const tick = setInterval(() => {
  readReport()
  if (existsSync(path.join(dir, "cancel"))) stop("cancelled", "Cancelled by user or agent")
  if (config.timeout && Date.now() - task.created >= config.timeout * 1000) {
    task.timeoutKind = "maximum"
    stop("timed_out", `Maximum runtime exceeded (${config.timeout}s)`)
  }
  if (!stopped && config.idle_timeout && Date.now() - lastActivity >= config.idle_timeout * 1000) {
    task.timeoutKind = "idle"
    stop("timed_out", `No output or progress for ${config.idle_timeout}s`)
  }
  if (dirty || Date.now() - task.heartbeat >= 1000) save()
}, 200)
child.on("close", (code, sig) => {
  clearInterval(tick)
  if (killTimer) clearTimeout(killTimer)
  // Clean up descendants and custom collectors, including shell-backgrounded children.
  signal(child, "SIGKILL")
  signal(observer, "SIGKILL")
  readReport()
  task.status = stopped ?? (code === 0 ? "succeeded" : "failed")
  task.exitCode = code ?? undefined
  task.signal = sig ?? undefined
  task.ended = Date.now()
  task.updated = task.ended
  task.message = stopped ? stopMessage : code === 0 ? "Completed" : `Command failed (${sig ?? code})`
  if (task.status === "failed" && !task.error) task.error = task.message
  // Preserve the last measured percentage; command success alone does not measure work.
  task.version++
  save()
})
