#!/bin/sh
set -eu

# Docker preserves the host GID on mounted GPU devices. Add the unprivileged app
# user to those groups at startup, then drop root before launching Watchhouse.
if [ "$(id -u)" = "0" ]; then
  device_groups=''
  for device in /dev/dri/renderD* /dev/dri/card* /dev/nvidia*; do
    [ -e "$device" ] || continue
    device_gid=$(stat -c '%g' "$device")
    device_group=$(getent group "$device_gid" | cut -d: -f1)
    if [ -z "$device_group" ]; then
      device_group="watchhouse-gpu-$device_gid"
      groupadd --gid "$device_gid" "$device_group"
    fi
    case ",$device_groups," in
      *,"$device_group",*) ;;
      *) device_groups="${device_groups}${device_groups:+,}$device_group" ;;
    esac
  done

  if [ -n "$device_groups" ]; then
    usermod -aG "$device_groups" node
  fi
  exec gosu node "$@"
fi

exec "$@"
