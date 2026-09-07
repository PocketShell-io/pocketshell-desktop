#!/bin/sh
# Entrypoint for the pocketshell-test:helper image.
#
# Starts sshd in the foreground (the container's main process) and, just
# before that, seeds two live detached tmux sessions as testuser so
# `pocketshell sessions list` returns a non-empty tree for tests. tmux
# sessions survive because they are detached and owned by the testuser
# server process group.
set -e

# Seed live tmux sessions owned by testuser (idempotent: skip if present).
su testuser -c '
  if ! tmux has-session -t main 2>/dev/null; then
    tmux new-session -d -s main -c "$HOME"
    tmux new-session -d -s build -c "$HOME"
  fi
'

# Seed the same two sessions under aplexer. With `a` installed the app lists
# from the aplexer snapshot ALONE (PocketshellClient.listSessions) — the tmux
# seeds above are invisible to it — so these are the rows the E2E panel
# assertions actually count. kill+forget first make the seed idempotent across
# a `compose stop`/`up` cycle, where the container and its records survive but
# the workers died with it: `a start` refuses a workspace+tag held by ANY
# existing record, live or exited. The kill's settle sleep runs only when
# there was something to kill (first boot takes no detour).
su testuser -c '
  for tag in main build; do
    if a kill --workspace "$HOME" --tag "$tag" --signal KILL --grace-ms 500 \
        >/dev/null 2>&1; then
      sleep 1
    fi
    a forget --workspace "$HOME" --tag "$tag" --force >/dev/null 2>&1 || true
    a start --workspace "$HOME" --tag "$tag" --json >/dev/null 2>&1 || true
  done
'

# The standalone local instance supplies an overlay after the server exists.
# The normal helper fixture leaves this unset, so its deterministic defaults
# and tests are unchanged.
if [ -n "${POCKETSHELL_TMUX_OVERLAY:-}" ]; then
  su -m testuser -c "tmux source-file '$POCKETSHELL_TMUX_OVERLAY'"
fi

# Start the deterministic traffic responder (inherited from the :ssh layer).
# This image replaces that layer's CMD, so without this line the helper — the
# image the E2E screenshots come from — would keep showing "0 B" for every
# forward. See tests-docker/traffic-server.py.
TRAFFIC_PORT="${PS_TRAFFIC_PORT:-8021}"
su testuser -c "setsid /usr/local/bin/ps-traffic-server $TRAFFIC_PORT \
  </dev/null >/tmp/traffic-server.log 2>&1 &"

# Run sshd in the foreground so the container stays up and logs to stderr.
exec /usr/sbin/sshd -D -e
