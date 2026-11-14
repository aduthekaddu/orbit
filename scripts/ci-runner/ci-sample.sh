#!/usr/bin/env bash
# Samples romper every 5 s while CI runs: host MemAvailable, the ci slice's memory, and each
# CI VM's resident memory and CPU. One line per sample:
#   UTC-time mem_available_mb ci_slice_mb [place:rss_mb:cpu_pct ...]
# runner-up's own usage readings do not cover KVM places, so this is the per-job measure.
set -u
interval=${1:-5}
declare -A last_ticks
hz=$(getconf CLK_TCK)
while :; do
  avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
  slice=$(( $(cat /sys/fs/cgroup/user.slice/user-1500.slice/memory.current 2>/dev/null || echo 0) / 1048576 ))
  line="$(date -u +%H:%M:%S) $avail $slice"
  # The kernel cuts process names to 15 characters: qemu-system-x86_64 shows as qemu-system-x86.
  for pid in $(pgrep -u ci -x qemu-system-x86 2>/dev/null); do
    name=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -oE -- '-name [^ ]+' | cut -d' ' -f2)
    rss=$(awk '/^VmRSS:/ {print int($2 / 1024)}' "/proc/$pid/status" 2>/dev/null)
    ticks=$(awk '{print $14 + $15}' "/proc/$pid/stat" 2>/dev/null)
    cpu=0
    if [ -n "${last_ticks[$pid]:-}" ] && [ -n "$ticks" ]; then
      cpu=$(( (ticks - last_ticks[$pid]) * 100 / hz / interval ))
    fi
    last_ticks[$pid]=$ticks
    line+=" ${name:-pid$pid}:${rss:-0}:$cpu"
  done
  echo "$line"
  sleep "$interval"
done
