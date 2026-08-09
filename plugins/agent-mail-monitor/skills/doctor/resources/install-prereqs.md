# Fix: install the Agent Mail surface's prerequisites

The Deno monitor tails the canonical git-mailbox directly in project/all scope
and uses `am products inbox` in product scope. It never calls the consuming
`am check-inbox` path. The doctor and bundled shell diagnostics use `am`, `jq`,
and `curl`, so all three must be on `PATH` for the complete plugin surface.

## `am` — the Agent Mail CLI

`am` is the CLI of **[Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)**.
The project's recommended install is a shell script that downloads the right
binary for your platform into `~/.local/bin` (Linux/macOS, x86_64/aarch64):

```bash
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail_rust/main/install.sh?$(date +%s)" | bash
```

Or build from source (needs Rust nightly + the project's sibling checkouts):

```bash
git clone https://github.com/Dicklesworthstone/mcp_agent_mail_rust
cd mcp_agent_mail_rust
./install-local.sh          # builds release, installs to ~/.local/bin
```

Make sure `~/.local/bin` is on `PATH`, then verify:

```bash
command -v am && am --version   # resolves and prints a version
```

## `jq`

```bash
# Debian/Ubuntu
sudo apt install jq
# Arch
sudo pacman -S jq
# macOS
brew install jq
```

## `curl`

Almost always preinstalled. If not, install it from your package manager
(`apt install curl` / `pacman -S curl` / `brew install curl`).

## Verify

```bash
command -v am jq curl
```

All three should print a path. Re-run the doctor once they do.
