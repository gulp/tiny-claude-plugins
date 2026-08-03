#!/usr/bin/env bash
# Shared per-pane mcp-agent-mail worker identity — a capture of `ralph identity`.
# The engine is a command on PATH, never a file: no source, no engine function,
# no RALPH_HOME. Source, then call `resolve_worker_identity <prog> [name]`.

resolve_worker_identity() {
    local program="${1:?resolve_worker_identity requires a program (e.g. cursor-agent|claude-code)}"
    command -v ralph >/dev/null 2>&1 || {
        echo "✗ worker-identity: cannot find the ralph engine — no 'ralph' on PATH." >&2
        echo "  Run install.sh from the engine checkout." >&2
        return 1
    }
    if [ -n "${2-}" ]; then
        AGENT_NAME="$(ralph identity --program "$program" --name "$2")" || return 1
    else
        AGENT_NAME="$(ralph identity --program "$program")" || return 1
    fi
    export AGENT_NAME
}
