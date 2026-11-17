#!/bin/bash
# Qwen does the work, Opus orchestrates and verifies (owner's rule, 2026-11-17; same model
# as the TDv3 projects' /media/nvme/TDv3/.qwen/qwen.sh). Runs headless Claude Code on the
# local Qwen model (bc250 llama.cpp, Qwen3.5-9B) inside the claude-agent container, in
# this repo (/workspace = /root/3d-printer-control-center on the Pi).
#
#   tools/qwen.sh start <name> <read|edit|git> <prompt-file>
#   tools/qwen.sh status <name>        running / finished + last activity
#   tools/qwen.sh log <name> [n]       compact view: tool calls, refusals, final answer
#   tools/qwen.sh stop <name>
#
# Profiles: read = look only (files, git history, GET requests via tools/qwen-bin/http-get);
# edit = also change files (left uncommitted for review);
# git  = edit + commit, on branch qwen/<name> created from master by this script.
# Never: push, touch master, docker/systemd, POST to printers, delete files. The
# orchestrator reviews the diff, merges, builds, deploys, verifies and pushes.
set -eu
REPO=/workspace
DIR=$REPO/data/qwen-tasks
QHOME=/root/.qwen-home            # separate HOME: never uses the orchestrator's login/settings
KEYFILE=/root/.config/qwen/api.key
BIN=$REPO/tools/qwen-bin
cmd=${1:-}; name=${2:-}
[ -n "$cmd" ] && [ -n "$name" ] || { sed -n 2,17p "$0"; exit 2; }
[[ $name =~ ^[A-Za-z0-9_-]+$ ]] || { echo "name: letters, digits, - and _ only"; exit 2; }
mkdir -p "$DIR" "$QHOME"
pidf=$DIR/$name.pid
# A finished worker can stay a zombie (the container's PID 1 doesn't reap orphans).
running() {
  [ -f "$pidf" ] || return 1
  local st; st=$(sed -n 's/^State:\s*\(.\).*/\1/p' "/proc/$(cat "$pidf")/status" 2>/dev/null)
  [ -n "$st" ] && [ "$st" != Z ]
}

READ_TOOLS=(Read Grep Glob 'Bash(cat:*)' 'Bash(ls:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(grep:*)'
  'Bash(wc:*)' 'Bash(find:*)' 'Bash(file:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git status:*)'
  'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git ls-files:*)' 'Bash(git blame:*)'
  "Bash($BIN/http-get:*)")
EDIT_TOOLS=("${READ_TOOLS[@]}" Edit Write 'Bash(mkdir:*)')
GIT_TOOLS=("${EDIT_TOOLS[@]}" 'Bash(git add:*)' 'Bash(git commit:*)')
DENY=('Bash(rm:*)' 'Bash(mv:*)' 'Bash(curl:*)' 'Bash(wget:*)' 'Bash(ssh:*)' 'Bash(scp:*)'
  'Bash(docker:*)' 'Bash(systemctl:*)' 'Bash(sudo:*)' 'Bash(kill:*)' 'Bash(pkill:*)'
  'Bash(chmod:*)' 'Bash(chown:*)' 'Bash(env:*)' 'Bash(printenv:*)' 'Bash(python3:*)' 'Bash(node:*)'
  'Bash(git push:*)' 'Bash(git config:*)' 'Bash(git credential:*)' 'Bash(git reset:*)'
  'Bash(git rebase:*)' 'Bash(git checkout:*)' 'Bash(git switch:*)' 'Bash(git merge:*)'
  'Bash(git clean:*)' 'Bash(git stash:*)' 'Bash(git branch -D:*)' 'Bash(git branch -d:*)'
  'Bash(git tag:*)' 'Read(/root/**)' 'Read(/workspace/.env)' WebFetch WebSearch)

RULES='You are a worker agent on a home 3D-printer control center (Node/TypeScript backend, Preact frontend) running on an Orange Pi; six printers are in production. An orchestrator agent planned this task and will review and verify everything you do.
Rules: only touch files inside /workspace; never delete files; never commit to master; never push; never send anything but GET requests (use the http-get helper; there is no curl); never add secrets to git.
Run one command per Bash call (no &&, ; or pipes) and quote paths and URLs, or the permission check rejects it.
If a command or edit is denied or fails, STOP the task at once and report it. Do not try another tool or command to get around it, and do not continue with later steps. Never invent output, log lines, file contents or quotes: copy them exactly, or say you did not find them.
Be concise. Finish with a section "## Result" listing exactly what you did (commands, files changed, commit hashes), your findings with their evidence, and anything that failed.'

case "$cmd" in
start)
  profile=${3:-}; pf=${4:-}
  case "$profile" in read) tools=("${READ_TOOLS[@]}");; edit) tools=("${EDIT_TOOLS[@]}");;
    git) tools=("${GIT_TOOLS[@]}");; *) echo "profile: read, edit or git"; exit 2;; esac
  [ -f "$pf" ] || { echo "prompt file not found: $pf"; exit 2; }
  running && { echo "$name is already running"; exit 1; }
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
  if [ "$profile" = git ]; then
    # Qwen commits on its own branch, cut from master, in a clean tree.
    [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] || { echo "working tree has uncommitted changes: commit or stash them first"; exit 1; }
    git -C "$REPO" switch -q master
    git -C "$REPO" switch -q -c "qwen/$name" || { echo "branch qwen/$name exists"; exit 1; }
  fi
  cp "$pf" "$DIR/$name.prompt"; : > "$DIR/$name.jsonl"; : > "$DIR/$name.err"
  key=$(tr -d '\n' < "$KEYFILE")
  (cd "$REPO" && exec env -i HOME="$QHOME" PATH=/usr/local/bin:/usr/bin:/bin TERM=dumb \
    ANTHROPIC_BASE_URL=http://10.0.68.30:8888 ANTHROPIC_AUTH_TOKEN="$key" \
    ANTHROPIC_MODEL=qwen ANTHROPIC_SMALL_FAST_MODEL=qwen \
    ENABLE_TOOL_SEARCH=false DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    API_TIMEOUT_MS=600000 \
    GIT_AUTHOR_NAME=Oshan GIT_AUTHOR_EMAIL=oshanrube@gmail.com \
    GIT_COMMITTER_NAME=Oshan GIT_COMMITTER_EMAIL=oshanrube@gmail.com \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' \
    nohup claude -p --output-format stream-json --verbose --max-turns 60 \
      --permission-mode default --append-system-prompt "$RULES" \
      --allowedTools "${tools[@]}" --disallowedTools "${DENY[@]}" \
      < "$DIR/$name.prompt" > "$DIR/$name.jsonl" 2> "$DIR/$name.err") &
  echo $! > "$pidf"
  echo "started $name ($profile)$([ "$profile" = git ] && echo " on branch qwen/$name"): log $DIR/$name.jsonl"
  ;;
status)
  if running; then st=running; else st=finished; fi
  n=$(wc -l < "$DIR/$name.jsonl" 2>/dev/null || echo 0)
  echo "$name: $st, $n events, last write $(date -r "$DIR/$name.jsonl" +%H:%M:%S 2>/dev/null || echo never)"
  ;;
wait)
  # Block until the task finishes (max ${3:-20} min), then print the compact log.
  end=$(( $(date +%s) + ${3:-20} * 60 ))
  while running && [ "$(date +%s)" -lt "$end" ]; do sleep 5; done
  "$0" status "$name"; "$0" log "$name" 40
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
                lines.append(f"-> {b['name']}: {str(arg)[:200]}")
            elif b.get('type') == 'text' and b.get('text', '').strip():
                lines.append(f"   says: {b['text'].strip()[:200]}")
    elif t == 'user':
        c = ev.get('message', {}).get('content')
        for b in c if isinstance(c, list) else []:
            if b.get('type') == 'tool_result' and b.get('is_error'):
                r = b.get('content'); r = r if isinstance(r, str) else json.dumps(r)
                lines.append(f"   ! {r[:200]}")
    elif t == 'result':
        lines.append(f"== done: {ev.get('subtype')}, {ev.get('num_turns')} turns, {round((ev.get('duration_ms') or 0)/60000, 1)} min")
        lines.append(str(ev.get('result', ''))[:4000])
for l in lines[-n:]: print(l)
EOF
  [ -s "$DIR/$name.err" ] && { echo "--- stderr:"; tail -5 "$DIR/$name.err"; } || true
  ;;
stop) running && kill "$(cat "$pidf")" && echo "stopped $name" || echo "$name not running" ;;
*) echo "unknown command"; exit 2 ;;
esac
