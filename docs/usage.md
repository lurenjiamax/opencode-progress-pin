# 使用说明

安装与兼容性见 [README](../README.md)。

## Agent 工具

工具名为 `progress_start`、`progress_report`、`progress_list`、`progress_status`、`progress_cancel`；Code Mode 中为 `tools.progress.start(...)` 等。插件会自动向 Agent 提供使用说明。

### 一次调用运行长命令

```js
await tools.progress.start({
  label: "训练模型",
  command: "python3 train.py",
  timeout: 7200,
})
```

立即返回 task ID；命令在后台运行，日志落盘，完成时只发一次持久 synthetic 通知给原会话。Agent 可继续其他工作，不应循环查询状态。通知失败会重试；稳定的消息 ID 防止重载后重复投递。需要排查时再调用 `status` 读取最近日志。

- `timeout`：可选最大运行秒数，**省略或 0 不限时**。
- `idle_timeout`：可选无输出且无进度的秒数，默认关闭。静默计算不应随便开启此项。
- 超时是独立的 `timed_out` 终态，并记录 `timeoutKind=maximum/idle`；发送 TERM，最多 3 秒后 KILL。保留日志和最后实际进度。
- `cancel` 同样终止进程组及采集器。Linux 优先 systemd 用户服务，无法使用时退回 detached worker。
- 成功、普通失败、取消、超时、中断分别展示。命令退出 0 只标记成功，**不会强行把未测量的百分比变成 100%**。
- `cwd` 默认为会话目录；`env` 可显式提供命令环境变量。不会复制服务器中的 provider 凭据；桌面/运行路径等必要环境以及显式变量保存于私有任务配置。
- `notify:false` 关闭 Agent 完成通知，适合手动演示。

### 像 tqdm 一样 wrap

通过工具运行的 Python 自动获得 helper 的 `PYTHONPATH`，无需 pip 安装。

```python
from opencode_progress import progress

for item in progress(items, desc="建立索引", unit="files"):
    process(item)
```

有 `len()` 的输入自动得到总量；生成器没有总量就只汇报计数和状态，也可显式传 `total=`。

```python
with progress(total=100, desc="下载", unit="MB") as bar:
    bar.update(5)
    bar.set_description("解压")
    bar.set_postfix_str("当前文件 archive.tar")
```

更新默认按 0.2 秒节流；正常结束、异常和提前退出保留真实计数。helper 从不决定整个命令的成功状态。

### 自动解析现有命令

默认 `parser:"auto"` 识别 stdout/stderr 中的百分比、`current/total` 和 tqdm 风格的回车刷新输出。它是启发式解析；日志中的比例可能不代表整体进度，遇到这种情况选择以下明确方式，或用 `parser:"none"` 只显示状态。

```js
await tools.progress.start({
  label: "导出",
  command: "my-exporter",
  parser: "regex",
  pattern: "done=(?<current>\\d+) total=(?<total>\\d+)",
})
```

正则使用 JavaScript named captures：`current`、`total`、`percent`、`phase`、`message`、`unit`。

### 自定义进度生产

**任意语言直接输出：**所有 parser 模式都支持一行 `@@progress ` 加 JSON。

```text
@@progress {"current":25,"total":100,"phase":"下载","message":"archive.tar","unit":"MB"}
@@progress {"total":null,"percent":null,"phase":"解压","message":"正在等待解压结束"}
```

`parser:"json"` 还接受不带前缀的 JSON 行。

**Python 主动汇报：**

```python
from opencode_progress import report
report(percent=37.5, phase="同步", message="上传分片")
report(total=None, percent=None, phase="等待确认")
```

**Shell 汇报：**

```sh
python3 -m opencode_progress --current 25 --total 100 --phase 下载
python3 -m opencode_progress --indeterminate --phase 解压
```

也可原子替换环境变量 `OPENCODE_PROGRESS_FILE` 指向的 JSON 文件。文件协议使用绝对当前值；不要原地写半个 JSON。多生产者是“最后更新者覆盖”语义，复杂任务建议单个聚合器汇报。

**独立采集器：**适合不能修改的程序、下载器状态文件、训练指标文件等。

```js
await tools.progress.start({
  label: "训练",
  command: "python3 train.py",
  progress_command: "python3 observe_metrics.py",
})
```

采集器自行控制采样频率，向 stdout 输出 JSON 行或原子写进度文件。可读取 `OPENCODE_PROGRESS_PID`、`OPENCODE_PROGRESS_TASK`。采集器和主命令共享工作目录，主命令结束后采集器被终止；采集器失败显示警告，不冒充主命令失败。

### Agent 汇报多步骤任务

```js
const result = await tools.progress.start({ label: "迁移配置", total: 3, unit: "步骤", notify: false })
// 使用工具返回的实际 task.id
await tools.progress.report({ task_id: "pin_…", current: 1, phase: "读取完成" })
await tools.progress.report({ task_id: "pin_…", current: 3, status: "succeeded", message: "迁移已验证" })
```

省略 `command` 即创建手动 tracker；Agent 必须明确结束它。命令任务可以手动补充进度，但其终态由退出码、取消和超时决定。

## 前端行为

- 面板显示当前会话及其子会话的任务，其他会话不会混入。
- 有数据时显示进度条、百分比、耗时和基于已测量进度的估算 ETA；没有数据只显示状态/阶段/耗时，不显示假百分比。
- 默认最多 3 条，矮终端自动减少；`/progress` 查看全部、详情、日志或取消任务。
- 成功条目 30 秒后自动收起；失败/超时保留。`/progress-clear` 收起所有已结束条目，不删除日志。
- RPC 推送变化；定期快照修复断线后的漏事件。连接中断时保留上次进度并提示正在重连。
- 支持的终端还会收到 OSC 9;4：单任务已知进度显示百分比，多任务/Agent 工作中显示不定进度，异常显示错误状态。支持 Ghostty、WezTerm、iTerm2、Windows Terminal、可确认版本的 kitty 0.47+；其他终端可设 `OPENCODE_PROGRESS_OSC=1` 强制启用。`OPENCODE_TERMINAL_PROGRESS=0` 可关闭终端 OSC；固定面板仍工作。

## 持久化与边界

任务写入 `${XDG_STATE_HOME:-~/.local/state}/opencode-progress-pin/<location-hash>/<task-id>/`，配置/状态/日志权限为 0600，目录为 0700。日志按 10 MiB 轮转，保留当前和上一份。任务与 worker 独立于 TUI，重开界面会恢复快照；插件重载会补发未送达通知，已死 worker 标为中断，不自动重复启动命令。系统重启后不会自动重跑，是否跨注销运行取决于 systemd 用户服务/linger 设置。

OpenCode 2.0.26 尚未提供新版插件 `permission.assert`：兼容路径只接受 Agent/Session 中明确匹配的 `allow`，遇到 `ask` 或 `deny` 返回说明，不静默越权。新版宿主提供该 API 时自动使用原生交互授权。

远程终端客户端只通过 RPC 访问进度，任务文件留在服务端；TUI 插件仍需在客户端安装。本版本交付 TUI，不包含 Desktop GUI 面板。正则由 Agent 提供，应避免灾难性回溯表达式。

## 实际演示

```js
await tools.progress.start({ label: "Python wrap", command: "python3 examples/demo.py --mode wrap" })
await tools.progress.start({ label: "自动解析", command: "python3 examples/demo.py --mode auto" })
await tools.progress.start({ label: "未知进度", command: "python3 examples/demo.py --mode unknown" })
await tools.progress.start({ label: "超时", command: "sleep 60", timeout: 2 })
```
