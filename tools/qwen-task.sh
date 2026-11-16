#!/bin/sh
# Run a task on the local Qwen model (bc250 llama.cpp) with headless Claude Code, so the
# Opus session only plans and reviews. Runs on the Pi host as a transient systemd unit
# (survives the caller), logging stream-json to data/qwen-tasks/<name>.jsonl.
#
#   qwen-task.sh start <name> <read|edit> <prompt-file>
#   qwen-task.sh status <name>      running / finished + last activity
#   qwen-task.sh log <name> [n]     compact view: tool calls, errors, final answer
#   qwen-task.sh stop <name>
#
# Profiles: read = look only (files, logs, DB, GET requests); edit = also change repo files.
# Neither may deploy, restart services, commit/push, delete, or send commands to printers:
# the Opus session reviews and does those. (2026-11-15: a Qwen session rebuilt and
# started the app with a bare `docker run`, losing push and AI detection for 10 h.)
set -eu
REPO=/root/3d-printer-control-center
DIR=$REPO/data/qwen-tasks
CLAUDE=/home/agent/.local/bin/claude
cmd=${1:-}; name=${2:-}
[ -n "$cmd" ] && [ -n "$name" ] || { sed -n 2,13p "$0"; exit 2; }
case "$name" in *[!a-zA-Z0-9_-]*) echo "name: letters, digits, - and _ only"; exit 2;; esac
mkdir -p "$DIR"
unit="qwen-$name"

# Tool lists are |-separated (patterns contain spaces).
READ_TOOLS='Read|Grep|Glob|Bash(cat:*)|Bash(ls:*)|Bash(head:*)|Bash(tail:*)|Bash(grep:*)|Bash(wc:*)|Bash(find:*)|Bash(git log:*)|Bash(git diff:*)|Bash(git status:*)|Bash(git show:*)|Bash(docker ps:*)|Bash(docker logs:*)|Bash(curl -s:*)|Bash(sqlite3:*)|Bash(journalctl:*)'
EDIT_TOOLS="$READ_TOOLS|Edit|Write"
DENY='Bash(docker run:*)|Bash(docker rm:*)|Bash(docker stop:*)|Bash(docker kill:*)|Bash(docker restart:*)|Bash(docker compose:*)|Bash(docker build:*)|Bash(docker exec:*)|Bash(systemctl:*)|Bash(git commit:*)|Bash(git push:*)|Bash(git reset:*)|Bash(git checkout:*)|Bash(rm:*)|Bash(mv:*)|Bash(curl -s -X:*)|Bash(curl -s -d:*)|Bash(curl -s --data:*)|Bash(curl -s --request:*)|Bash(reboot:*)|Bash(shutdown:*)|Bash(kill:*)|Bash(pkill:*)'

RULES='You are a worker agent on a home 3D-printer control center (Orange Pi). Another agent planned this task and will review your result.
Rules: never deploy, rebuild, restart or stop anything; never send commands to printers (no POST requests; GET only); never commit or push; never delete files.
Run one command per Bash call (no &&, ; or pipes into other programs) and put URLs in single quotes, or the permission check rejects it.
If something you need is denied, say so in your answer instead of working around it.
Be concise. Finish with a section "## Result" with your findings or a list of the files you changed and why.'

case "$cmd" in
start)
  profile=${3:-}; pf=${4:-}
  case "$profile" in read) tools=$READ_TOOLS;; edit) tools=$EDIT_TOOLS;; *) echo "profile: read or edit"; exit 2;; esac
  [ -f "$pf" ] || { echo "prompt file not found: $pf"; exit 2; }
  if systemctl is-active --quiet "$unit"; then echo "$unit is already running"; exit 1; fi
  systemctl reset-failed "$unit" 2>/dev/null || true
  cp "$pf" "$DIR/$name.prompt"
  : > "$DIR/$name.jsonl"
  # Build argv without a shell in between (no globbing, patterns keep their spaces).
  set -f
  set -- "$CLAUDE" -p --output-format stream-json --verbose --max-turns 40 \
    --permission-mode default --append-system-prompt "$RULES" --allowedTools
  old=$IFS; IFS='|'
  for t in $tools; do set -- "$@" "$t"; done
  set -- "$@" --disallowedTools
  for t in $DENY; do set -- "$@" "$t"; done
  IFS=$old; set +f
  systemd-run --unit "$unit" --collect --quiet \
    --working-directory="$REPO" \
    -E HOME=/home/agent -E PATH=/opt/node22/bin:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin \
    -p StandardInput=file:"$DIR/$name.prompt" \
    -p StandardOutput=file:"$DIR/$name.jsonl" \
    -p StandardError=file:"$DIR/$name.err" \
    "$@"
  echo "started $unit ($profile): log $DIR/$name.jsonl"
  ;;
status)
  if systemctl is-active --quiet "$unit"; then st=running; else st=finished; fi
  n=$(wc -l < "$DIR/$name.jsonl" 2>/dev/null || echo 0)
  echo "$unit: $st, $n events, last write $(date -r "$DIR/$name.jsonl" +%H:%M:%S 2>/dev/null || echo never)"
  ;;
log)
  python3 - "$DIR/$name.jsonl" "${3:-25}" <<'EOF'
import json, sys
path, n = sys.argv[1], int(sys.argv[2])
lines = []
for raw in open(path, errors='replace'):
    try: ev = json.loads(raw)
    except Exception: continue
    t = ev.get('type')
    if t == 'assistant':
        for b in ev.get('message', {}).get('content', []):
            if b.get('type') == 'tool_use':
                i = b.get('input', {})
                arg = i.get('command') or i.get('file_path') or i.get('pattern') or json.dumps(i)[:120]
                lines.append(f"-> {b['name']}: {str(arg)[:160]}")
            elif b.get('type') == 'text' and b.get('text', '').strip():
                lines.append(f"   says: {b['text'].strip()[:200]}")
    elif t == 'user':
        for b in ev.get('message', {}).get('content', []) if isinstance(ev.get('message', {}).get('content'), list) else []:
            if b.get('type') == 'tool_result' and b.get('is_error'):
                c = b.get('content'); c = c if isinstance(c, str) else json.dumps(c)
                lines.append(f"   ! {c[:160]}")
    elif t == 'result':
        lines.append(f"== done: {ev.get('subtype')}, {ev.get('num_turns')} turns, {round((ev.get('duration_ms') or 0)/60000, 1)} min")
        lines.append(str(ev.get('result', ''))[:4000])
for l in lines[-n:]: print(l)
EOF
  [ -s "$DIR/$name.err" ] && { echo "--- stderr:"; tail -5 "$DIR/$name.err"; } || true
  ;;
stop) systemctl stop "$unit" && echo "stopped $unit" ;;
*) echo "unknown command"; exit 2 ;;
esac
