/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { writeSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { ProgressPin } from "./rpc"
import { clean, terminal, type Task, type Status } from "./model"

const labels: Record<Status, string> = {
  starting: "启动中", running: "运行中", paused: "已暂停", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", interrupted: "执行中断", timed_out: "超时",
}
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`
}
const measured = (t: Task) => typeof t.percent === "number" ? t.percent : t.total && t.current !== undefined ? Math.min(100, t.current / t.total * 100) : undefined
const bar = (percent: number) => {
  const count = Math.round(Math.max(0, Math.min(100, percent)) / 10)
  return "━".repeat(count) + "─".repeat(10 - count)
}

// Terminal progress is optional and separate from the pinned panel. Unsupported
// terminals are a no-op; never send escape codes through the server's stdout.
function terminalWriter(enabled: boolean) {
  const program = process.env.TERM_PROGRAM ?? ""
  let kitty = false
  if (process.env.KITTY_WINDOW_ID && (!program || program === "kitty")) {
    try {
      const version = execFileSync("kitty", ["--version"], { encoding: "utf8", timeout: 1500 }).match(/kitty (\d+)\.(\d+)/)
      kitty = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 47)
    } catch { /* cannot confirm terminal protocol support */ }
  }
  const supported = /^(ghostty|iTerm\.app|WezTerm|Windows_Terminal)$/i.test(program) || !!process.env.WT_SESSION || !!process.env.ITERM_SESSION_ID || kitty
  let previous = ""
  return (state: number, percent?: number) => {
    if (!enabled || (!supported && process.env.OPENCODE_PROGRESS_OSC !== "1")) return
    let seq = `\x1b]9;4;${state}${percent === undefined ? "" : `;${Math.round(percent)}`}\x1b\\`
    if (seq === previous) return
    previous = seq
    if (process.env.TMUX) seq = `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
    try { writeSync(1, seq) } catch { /* terminal detached */ }
  }
}

export default Plugin.define({
  id: "opencode-progress-pin.tui",
  setup(context) {
    const client = context.client.rpc(ProgressPin)
    const [all, setAll] = createSignal<Task[]>([])
    const [now, setNow] = createSignal(Date.now())
    const [error, setError] = createSignal("")
    const [dismissed, setDismissed] = createSignal<string[]>([])
    let loading = false
    let disposed = false
    let first = true
    let previousLocation = ""
    const completed = new Set<string>()
    const theme = context.theme
    const location = () => {
      const route = context.ui.router.current()
      return route.type === "session"
        ? context.data.session.get(route.sessionID)?.location ?? context.location ?? context.data.location.default()
        : context.location ?? context.data.location.default()
    }
    const receive = (tasks: Task[]) => {
      if (disposed) return
      if (!first) for (const task of tasks) {
        if (!terminal(task.status) || completed.has(task.id) || task.ended! < Date.now() - 10000) continue
        completed.add(task.id)
        const route = context.ui.router.current()
        const family = route.type === "session" ? context.data.session.family(route.sessionID) : []
        if (route.type !== "session" || (task.sessionID !== route.sessionID && !family.includes(task.sessionID))) continue
        context.ui.toast.show({ title: "Progress Pin", message: `${task.label} · ${labels[task.status]}`, variant: task.status === "succeeded" ? "success" : task.status === "cancelled" ? "info" : "error" })
        void context.attention.notify({ title: "Progress Pin", message: `${task.label} · ${labels[task.status]}`, notification: { when: "blurred" }, sound: false })
      }
      for (const task of tasks) if (terminal(task.status)) completed.add(task.id)
      first = false
      setAll(tasks)
      setError("")
    }
    const refresh = async () => {
      if (loading || disposed) return
      loading = true
      const loc = location()
      const key = loc.directory ?? ""
      if (key !== previousLocation) { previousLocation = key; first = true; setAll([]) }
      try {
        const result = await client.list({}, { location: loc }) as { tasks: Task[] }
        if (key === (location().directory ?? "")) receive(result.tasks)
      } catch (e) { if (!disposed) setError(clean(String(e), 160)) }
      finally { loading = false }
    }
    const unsubscribe = client.events.on("changed", event => {
      if (event.location?.directory !== location().directory) return
      receive((event.data as { tasks: Task[] }).tasks)
    })
    const timer = setInterval(() => { setNow(Date.now()); void refresh() }, 2000)
    void refresh()
    const osc = terminalWriter(context.options.terminalProgress !== false && !/^(0|false|no)$/i.test(process.env.OPENCODE_TERMINAL_PROGRESS ?? ""))
    const visibleTasks = (sessionID: string) => {
      const family = new Set([sessionID, ...context.data.session.family(sessionID)])
      return all().filter(task => family.has(task.sessionID))
    }
    const color = (task: Task) => task.status === "succeeded" ? theme.text.feedback.success.base
      : ["failed", "interrupted", "timed_out"].includes(task.status) ? theme.text.feedback.error.base
        : task.status === "paused" ? theme.text.feedback.warning.base : theme.text.base
    const details = async (task: Task) => {
      try {
        const result = await client.status({ task_id: task.id, sessionID: task.sessionID, lines: 20 }, { location: location() }) as { task: Task; log: string }
        const t = result.task
        if (!terminal(t.status)) {
          const choice = await context.ui.dialog.select({ title: `${t.label} · ${labels[t.status]}`, options: [
            { title: "查看详情和日志", value: "logs" },
            { title: "取消任务", value: "cancel" },
          ] })
          if (choice === "cancel" && await context.ui.dialog.confirm({ title: "取消任务", message: `终止 ${t.label} 及其子进程？` })) {
            await client.cancel({ task_id: t.id, sessionID: t.sessionID }, { location: location() }); await refresh(); return
          }
          if (choice !== "logs") return
        }
        await context.ui.dialog.alert({ title: `${t.label} · ${labels[t.status]}`, message: [
          t.command ?? "Agent 手动汇报", t.cwd, t.message, t.error, t.warning,
          `最大运行：${t.timeout ? `${t.timeout}s` : "不限时"} · 空闲超时：${t.idleTimeout ? `${t.idleTimeout}s` : "关闭"}`,
          `进度更新时间：${new Date(t.updated).toLocaleString()} · 执行器：${t.runner}`,
          `退出码：${t.exitCode ?? "—"}${t.signal ? ` · 信号：${t.signal}` : ""}`,
          `日志：${t.logPath}`, result.log,
        ].filter(Boolean).join("\n") })
      } catch (e) { context.ui.toast.show({ message: clean(String(e)), variant: "error" }) }
    }
    context.keymap.layer(() => ({ mode: "global", commands: [
      { id: "progress-pin.tasks", title: "Progress Pin: 查看任务", palette: true, slash: { name: "progress" }, run: async () => {
        await refresh()
        const route = context.ui.router.current()
        const tasks = route.type === "session" ? visibleTasks(route.sessionID) : all()
        if (!tasks.length) { context.ui.toast.show({ message: "当前会话没有进度任务" }); return }
        const selected = await context.ui.dialog.select({ title: "Progress Pin", options: tasks.map(t => ({ title: `${labels[t.status]} · ${t.label}`, value: t.id, description: `${measured(t) === undefined ? "" : `${measured(t)!.toFixed(0)}% · `}${t.command ?? t.phase ?? "Agent"}` })) })
        const task = tasks.find(t => t.id === selected)
        if (task) await details(task)
      } },
      { id: "progress-pin.dismiss", title: "Progress Pin: 收起已结束任务", palette: true, slash: { name: "progress-clear" }, run: () => { setDismissed(all().filter(t => terminal(t.status)).map(t => t.id)) } },
    ] }))
    const slot = context.ui.slot({ append: "session.composer.top", render: props => {
      const family = createMemo(() => visibleTasks(props.sessionID))
      const shown = createMemo(() => family().filter(t => !dismissed().includes(t.id) && (!terminal(t.status) || t.status !== "succeeded" || now() - (t.ended ?? 0) < 30000))
        .sort((a, b) => Number(terminal(a.status)) - Number(terminal(b.status)) || b.created - a.created))
      const max = () => Math.min(5, Math.max(1, Number(context.options.maxVisible ?? 3)), Math.max(1, Math.floor((context.renderer.height - 16) / 3)))
      createEffect(() => {
        now()
        const route = context.ui.router.current()
        if (route.type !== "session" || route.sessionID !== props.sessionID) return
        const active = family().filter(t => !terminal(t.status))
        if (active.some(t => t.status === "paused") || context.data.session.permission.list(props.sessionID)?.length || context.data.session.form.list(props.sessionID)?.length) osc(4)
        else if (active.length === 1 && measured(active[0]) !== undefined) osc(1, measured(active[0]))
        else if (active.length || context.data.session.status(props.sessionID) === "running") osc(3)
        else if (family().some(t => ["failed", "timed_out", "interrupted"].includes(t.status) && now() - (t.ended ?? 0) < 10000)) osc(2)
        else osc(0)
      })
      return <Show when={shown().length > 0}>
        <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} marginBottom={1} backgroundColor={theme.background.raised.base}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text.base}>PIN · {shown().filter(t => !terminal(t.status)).length} 个运行任务</text>
            <text fg={theme.text.muted}>/progress · /progress-clear</text>
          </box>
          <For each={shown().slice(0, max())}>{task => {
            const percent = () => measured(task)
            const elapsed = () => (task.ended ?? now()) - task.created
            const eta = () => !terminal(task.status) && percent() !== undefined && percent()! > 0 && percent()! < 100
              ? ` · ETA ${duration(elapsed() * (100 - percent()!) / percent()!)}` : ""
            return <box flexDirection="column" onMouseDown={() => void details(task)}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={color(task)} wrapMode="none" flexShrink={1}>{labels[task.status]} · {task.label}{task.phase ? ` / ${task.phase}` : ""}</text>
                <text fg={color(task)} flexShrink={0}>{percent() === undefined ? "" : `${bar(percent()!)} ${percent()!.toFixed(0)}% · `}{duration(elapsed())}{eta()}</text>
              </box>
              <text fg={theme.text.muted} wrapMode="none">{task.command ? `$ ${clean(task.command, 180)}` : "Agent"}{task.total && task.current !== undefined ? ` · ${task.current}/${task.total} ${task.unit}` : ""}{task.message ? ` · ${task.message}` : ""}{task.timeout ? ` · 限时 ${task.timeout}s` : ""}{task.warning ? ` · ${task.warning}` : ""}</text>
            </box>
          }}</For>
          <Show when={shown().length > max()}><text fg={theme.text.muted}>另有 {shown().length - max()} 个任务 · /progress 查看全部</text></Show>
          <Show when={error()}><text fg={theme.text.feedback.warning.base}>连接中断 · 显示上次进度，正在重连</text></Show>
        </box>
      </Show>
    } })
    return () => { disposed = true; clearInterval(timer); unsubscribe(); slot(); osc(0) }
  },
})
