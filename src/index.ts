import { Plugin } from "@opencode/plugin"
import { Manager } from "./manager"
import { ProgressPin } from "./rpc"
import type { Start } from "./model"

const str = { type: "string" as const }
const num = { type: "number" as const, minimum: 0 }
const bool = { type: "boolean" as const }
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false })
const startSchema = schema({
  label: { ...str, description: "Short task title shown in the pinned progress panel" },
  command: { ...str, description: "Shell command. Omit to create a manual progress tracker for multi-step agent work." },
  cwd: str,
  parser: { type: "string", enum: ["auto", "json", "regex", "none"], description: "auto detects tqdm/percent/count output; json reads JSON lines; regex uses named captures; explicit @@progress JSON works in every mode" },
  pattern: { ...str, description: "Regex named captures: current, total, percent, message, phase, unit" },
  progress_command: { ...str, description: "Optional independent progress collector shell command; stdout JSON lines or write OPENCODE_PROGRESS_FILE. Receives OPENCODE_PROGRESS_PID." },
  total: { ...num, description: "Known total work, optional. Never invent a total." },
  unit: str,
  timeout: { ...num, description: "Optional maximum runtime in seconds; omitted or 0 means unlimited. Timeout terminates process tree and notifies agent." },
  idle_timeout: { ...num, description: "Optional seconds without output/progress before timeout; omitted or 0 disables." },
  env: { type: "object", additionalProperties: str, description: "Explicit command environment overrides. Saved privately with task configuration." },
  notify: { ...bool, description: "Notify this agent on completion (default true). Progress updates are UI-only." },
}, ["label"])
const reportSchema = schema({
  task_id: str, current: num, total: { anyOf: [num, { type: "null" }] },
  percent: { anyOf: [{ ...num, maximum: 100 }, { type: "null" }] },
  message: str, phase: str, unit: str,
  status: { type: "string", enum: ["running", "paused", "succeeded", "failed", "cancelled"], description: "Terminal status only for manual trackers. Command tasks finish from actual exit code." },
}, ["task_id"])
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("Object input required")
  return input as Record<string, unknown>
}
function required(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string" || !input[key]) throw new Error(`${key} required`)
  return input[key]
}
export default Plugin.define({
  id: "opencode-progress-pin",
  async setup(ctx) {
    const manager = new Manager(ctx)
    const rpc = await ctx.rpc.register(ProgressPin, {
      list: async input => {
        const args = record(input)
        return { tasks: manager.list(typeof args.sessionID === "string" ? args.sessionID : undefined) }
      },
      status: async input => {
        const args = record(input)
        return manager.status(required(args, "task_id"), required(args, "sessionID"), typeof args.lines === "number" ? args.lines : 30)
      },
      start: async input => {
        const args = record(input)
        return { task: await manager.start(args as unknown as Start, required(args, "sessionID")) }
      },
      report: async input => {
        const args = record(input)
        return manager.report(required(args, "task_id"), args, required(args, "sessionID"))
      },
      cancel: async input => {
        const args = record(input)
        return { task: manager.cancel(required(args, "task_id"), required(args, "sessionID")) }
      },
    })
    await ctx.tool.transform(editor => {
      const options = { namespace: "progress", codemode: true as const }
      editor.namespace({ name: "progress", description: "Pinned live progress and durable background commands. Use start once, then continue other work; completion is pushed automatically. Do not poll in a loop." })
      editor.add({
        name: "start", options, input: startSchema,
        description: "Start a background command with pinned progress, saved logs and automatic completion notification. Returns immediately. Auto-parses tqdm, percent and current/total output. Programs may use from opencode_progress import progress; progress(items), or emit @@progress JSON. Omit command for manual agent progress. timeout and idle_timeout are optional seconds, default unlimited.",
        execute: async (input, call) => {
          const task = await manager.start(input as Start, call.sessionID, call)
          return { content: JSON.stringify({ task, hint: "Task is pinned. Continue other work; completion notification will arrive. Use progress_report for manual updates; progress_status only when details are needed." }) }
        },
      })
      editor.add({
        name: "report", options, input: reportSchema,
        description: "Update a pinned task with measured current/total, percent, phase or message. Clear total/percent with null when the next phase is indeterminate. Finalize manual trackers with status=succeeded/failed. For commands, actual process exit is authoritative.",
        execute: async (input, call) => {
          const args = record(input)
          return { content: JSON.stringify(manager.report(required(args, "task_id"), args, call.sessionID)) }
        },
      })
      editor.add({
        name: "list", options, input: schema({}), description: "List this session's durable progress tasks. Do not poll; completion is automatically pushed.",
        execute: async (_input, call) => ({ content: JSON.stringify({ tasks: manager.list(call.sessionID) }) }),
      })
      editor.add({
        name: "status", options, input: schema({ task_id: str, lines: { type: "integer", minimum: 1, maximum: 200 } }, ["task_id"]),
        description: "Read a task's measured progress, timeout reason, exit code and bounded recent logs on demand.",
        execute: async (input, call) => {
          const args = record(input)
          return { content: JSON.stringify(manager.status(required(args, "task_id"), call.sessionID, args.lines as number | undefined)) }
        },
      })
      editor.add({
        name: "cancel", options, input: schema({ task_id: str }, ["task_id"]), description: "Cancel a task and its child processes; logs and measured progress are retained.",
        execute: async (input, call) => ({ content: JSON.stringify(manager.cancel(required(record(input), "task_id"), call.sessionID)) }),
      })
    })
    await ctx.session.hook("context", event => {
      event.system.push({ type: "text", text: "Progress Pin is available. For long-running shell commands prefer progress_start; it returns immediately and sends completion once. Set timeout (seconds) only when appropriate; omitted/0 means unlimited. Auto progress handles tqdm/percent/count output. For Python, from opencode_progress import progress; wrap with progress(items). For custom output emit '@@progress ' + JSON, or use a progress_command collector, or progress_report. For multi-step agent work start a manual tracker (no command), report real phases/counts, and finalize its status. Never invent percentages or poll repeatedly. Completion means inspect results and continue the user's goal." })
    })
    const publish = async (all: ReturnType<Manager["list"]>) => { await rpc.events.emit("changed", { tasks: all }) }
    const timer = setInterval(() => void manager.tick(publish).catch(error => console.error("[progress-pin]", error)), 500)
    void manager.tick(publish).catch(error => console.error("[progress-pin]", error))
    return () => clearInterval(timer)
  },
})
