#!/usr/bin/env bash

detect_platform() {
  local requested="${1:-}"
  if [[ -n "$requested" ]]; then
    case "$requested" in
      arch|debian) printf '%s\n' "$requested"; return ;;
      *) echo "unsupported platform override: $requested" >&2; return 1 ;;
    esac
  fi

  local id='' like=''
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release; printf '%s' "${ID:-}")"
    # shellcheck disable=SC1091
    like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
  fi
  case " $id $like " in
    *' arch '*) printf 'arch\n' ;;
    *' debian '*|*' ubuntu '*) printf 'debian\n' ;;
    *) echo 'supported Production Hosts use Arch or a Debian-family distribution' >&2; return 1 ;;
  esac
}

systemd_major_version() {
  systemd-creds --version 2>/dev/null | awk 'NR == 1 { print $2 }'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    return 1
  }
}
