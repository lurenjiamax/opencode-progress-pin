"""Real commands for trying the installed plugin, not a test suite.

progress_start(command="python3 examples/demo.py --mode wrap", label="Demo")
"""
import argparse
import json
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["wrap", "auto", "json", "unknown", "failure"], default="wrap")
parser.add_argument("--steps", type=int, default=40)
parser.add_argument("--delay", type=float, default=0.25)
args = parser.parse_args()

if args.mode == "wrap":
    from opencode_progress import progress
    for _ in progress(range(args.steps), desc="处理文件", unit="files"):
        time.sleep(args.delay)
elif args.mode == "unknown":
    print("正在等待外部处理结果", flush=True)
    time.sleep(args.steps * args.delay)
elif args.mode == "failure":
    print("示例任务失败：用于检查失败状态与日志", file=sys.stderr, flush=True)
    sys.exit(7)
else:
    for n in range(args.steps + 1):
        if args.mode == "auto":
            print(f"\r{n / args.steps * 100:.0f}% | {n}/{args.steps}", end="", flush=True)
        else:
            print("@@progress " + json.dumps({"current": n, "total": args.steps, "phase": "导出数据"}), flush=True)
        time.sleep(args.delay)
print("\nDone", flush=True)
