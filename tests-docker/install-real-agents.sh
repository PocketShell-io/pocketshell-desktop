#!/bin/sh
# Install the optional provider CLIs into the standalone instance's named
# agent-tools volume. Antigravity uses Google’s native installer. The caller must run this as testuser so npm's files and
# cache remain usable after a container is recreated.
set -eu

agent_tools_dir="${POCKETSHELL_AGENT_TOOLS_DIR:-/home/testuser/.agent-tools}"
codex_version="${POCKETSHELL_CODEX_VERSION:-latest}"
claude_code_version="${POCKETSHELL_CLAUDE_CODE_VERSION:-latest}"
force_install=false

case "${1:---ensure}" in
  --ensure) ;;
  --force) force_install=true ;;
  *)
    echo "usage: pocketshell-install-real-agents [--ensure|--force]" >&2
    exit 2
    ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  echo 'pocketshell-install-real-agents must run as testuser' >&2
  exit 2
fi

mkdir -p "$agent_tools_dir"
marker="$agent_tools_dir/.pocketshell-agent-spec"
spec="codex=${codex_version};claude-code=${claude_code_version};antigravity=latest"

if [ "$force_install" = false ] \
  && [ -x "$agent_tools_dir/bin/codex" ] \
  && [ -x "$agent_tools_dir/bin/claude" ] \
  && [ -x "$agent_tools_dir/bin/agy" ] \
  && [ -f "$marker" ] \
  && [ "$(cat "$marker")" = "$spec" ]; then
  exit 0
fi

echo "Installing Codex ${codex_version} and Claude Code ${claude_code_version} into ${agent_tools_dir}" >&2
npm install --global --prefix "$agent_tools_dir" --no-fund --no-audit \
  "@openai/codex@${codex_version}" \
  "@anthropic-ai/claude-code@${claude_code_version}"

if [ ! -x "$agent_tools_dir/bin/codex" ] || [ ! -x "$agent_tools_dir/bin/claude" ]; then
  echo "npm finished without both agent executables in ${agent_tools_dir}/bin" >&2
  exit 1
fi

# The official installer verifies the manifest checksum and accepts a custom
# bin directory. --compressed also handles the CDN's gzip HTTP response.
# This wrapper preserves an existing install unless --force was requested.
if [ "$force_install" = true ] || [ ! -x "$agent_tools_dir/bin/agy" ]; then
  agy_installer="$(mktemp)"
  trap 'rm -f "$agy_installer"' EXIT HUP INT TERM
  curl --compressed -fsSL https://antigravity.google/cli/install.sh -o "$agy_installer"
  # The bootstrapper refuses an existing binary. Preserve it until the new
  # installer succeeds by staging in a separate directory.
  agy_stage_dir="$(mktemp -d "$agent_tools_dir/.agy-install.XXXXXX")"
  trap 'rm -f "$agy_installer"; rm -rf "$agy_stage_dir"' EXIT HUP INT TERM
  bash "$agy_installer" --dir "$agy_stage_dir"
  test -x "$agy_stage_dir/agy"
  mv "$agy_stage_dir/agy" "$agent_tools_dir/bin/agy"
fi

printf '%s\n' "$spec" > "$marker"
