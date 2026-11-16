#!/bin/bash
# Power off after IDLE_MIN minutes of idleness. Run every 5 min by idle-shutdown.timer.
# Idle = GPU < 15% busy (10 s sample), 5-min load < 1.5, no SSH session or desktop input
# in the last 10 min, and no sound playing.
# Installed 2026-11-16 from the printer control center (Orange Pi).
# DRY_RUN=1 prints the decision without acting. Disable: systemctl disable --now idle-shutdown.timer
IDLE_MIN=${IDLE_MIN:-30}
STATE=/run/idle-shutdown.since
LOG=/var/log/idle-shutdown.log
busy=()

# GPU (games, local AI): highest busy % over 10 one-second samples.
max=0
for _ in $(seq 10); do
  for f in /sys/class/drm/card*/device/gpu_busy_percent; do
    v=$(cat "$f" 2>/dev/null || echo 0); [ "$v" -gt "$max" ] && max=$v
  done
  sleep 1
done
[ "$max" -ge 15 ] && busy+=("GPU ${max}%")

# CPU: 5-minute load average (12 threads).
load=$(cut -d" " -f2 /proc/loadavg)
awk -v l="$load" 'BEGIN { exit !(l >= 1.5) }' && busy+=("load $load")

# SSH: who -u layout varies ("user sshd pts/1 DATE TIME IDLE PID (host)"); the idle
# column is the field after the login time. "." = active this minute, 00:0x = under 10 min.
ssh_active=$(who -u | awk '
  $0 !~ / pts\// { next }
  { idle = ""
    for (i = 1; i < NF; i++) if ($i ~ /^[0-9][0-9]:[0-9][0-9]$/) { idle = $(i + 1); break }
    if (idle == "." || idle ~ /^00:0/) print $1 "@" $NF }' | sort -u | tr "\n" " ")
[ -n "$ssh_active" ] && busy+=("SSH ${ssh_active% }")

# Sound playing (videos, music, voice chat): any ALSA stream running.
grep -qs RUNNING /proc/asound/card*/pcm*/sub*/status && busy+=("audio playing")

# Desktop input (keyboard/mouse) in the last 10 min, from the X session.
auth=$(ps -eo args | grep -oE "Xorg.* -auth [^ ]+" | head -1 | sed "s/.* -auth //")
if [ -n "$auth" ] && command -v xprintidle >/dev/null; then
  xidle=$(DISPLAY=:0 XAUTHORITY="$auth" xprintidle 2>/dev/null || echo "")
  [ -n "$xidle" ] && [ "$xidle" -lt 600000 ] && busy+=("desktop input $((xidle / 1000)) s ago")
fi

now=$(date +%s)
if [ ${#busy[@]} -gt 0 ]; then
  rm -f "$STATE"
  [ -n "$DRY_RUN" ] && echo "busy: ${busy[*]}"
  exit 0
fi
[ -f "$STATE" ] || echo "$now" > "$STATE"
since=$(cat "$STATE"); idle=$(( (now - since) / 60 ))
if [ -n "$DRY_RUN" ]; then echo "idle for ${idle} min (GPU max ${max}%, load $load); shuts down at ${IDLE_MIN}"; exit 0; fi
if [ "$idle" -ge "$IDLE_MIN" ]; then
  echo "$(date "+%F %T") idle ${idle} min (GPU max ${max}%, load ${load}, no SSH/desktop/audio activity): powering off" >> "$LOG"
  systemctl poweroff
fi
