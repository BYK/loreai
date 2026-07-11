/**
 * CLI help text — printed by `lore help` and `lore --help`.
 */
import { VERSION } from "./version";

const USAGE = `
lore v${VERSION} — context management proxy for AI coding agents

Usage:
  lore [command] [options]

Commands:
  run [command] [args...]  Start gateway and launch an AI agent (default)
                           Extra arguments are forwarded to the launched agent
  start               Start the gateway server (without launching an agent)
                       Hosted mode is ON by default; use --local to disable.
                       Remote-gateway mode is also ON by default for long-running
                       setups — path-less sessions route to per-session buckets
                       so unrelated projects never merge onto the gateway cwd.
                       Use --bg to run it detached in the background.
  stop                Stop a background gateway started with \`lore start --bg\`
  setup [app]         Configure an AI app to route through lore. Prefer \`lore run\`
                       for terminal agents; use setup for GUI/IDE agents lore can't
                       launch, paired with a background gateway (\`lore start --bg\`).
                       Supported: claude-code, codex, opencode, pi, hermes, copilot, gemini
                       \`setup undo [app]\` reverts a previous setup (restores
                       the backup lore saved before it changed your config)
                       \`setup status\` prints a read-only inventory of what
                       setup has touched and where each agent is pointed
  doctor              Diagnose routing/env conflicts: setup inventory, gateway
                       reachability, port consistency, shell-env overrides,
                       Bedrock/Vertex conflicts, plugin install, version
  logs                Show lore activity log
  import              Import knowledge from prior AI agent conversations
  data <subcommand>   Manage stored data (list, show, clear, delete)
  recall <query>      Search project memory from the command line
  log [<id>]          Show knowledge version history (an entry's timeline, or
                       recent changes across the project)
  diff <id>           Show what changed between two versions of a knowledge entry
  login               Sign in to your Folk Lore account (GitHub or --email)
  logout              Sign out and clear the local session
  whoami              Show the signed-in Folk Lore account
  sync <subcommand>   Cloud-sync knowledge + entities (enable, disable, status, now)
  team <subcommand>   Manage shared team scopes (list, members, create, add, remove, set-role)
  entity <subcommand> Manage the entity registry (list, show, add, merge)
  upgrade [version]   Update lore to the latest (or specified) version
                       Flags: --check, --force, --offline, --channel <ch>
  help                Show this help text

Options:
  -p, --port <port>   Gateway port (default: 3207, env: LORE_LISTEN_PORT)
  -H, --host <host>   Gateway host(s), repeatable or comma-separated
                      (default: 127.0.0.1, env: LORE_LISTEN_HOST)
  -r, --remote <url>  Use a remote gateway instead of starting a local one
                      (env: LORE_REMOTE_URL)
  -l, --local         Disable hosted mode AND remote-gateway mode for
                      \`lore start\` (keep FS ops active; bucket cwd fallback)
                      (env: LORE_HOSTED_MODE=0)
      --bg, --daemon  \`lore start\`: run the gateway detached in the background,
                      then print its address, PID, and log path and exit
  -d, --debug         Enable debug logging (env: LORE_DEBUG=1)
      --no-plugin     Skip auto-install of the @loreai/<app> plugin
                      for \`lore setup <app>\` (use on CI, air-gapped
                      networks, or when npm is not on PATH)
  -v, --version       Print version and exit
  -h, --help          Show this help text

Log options (lore logs):
  -f, --follow        Follow log output in real-time
  -n, --lines <n>     Number of lines to show (default: 50)
  --path              Print log file path and exit

Data subcommands:
  data list <type>              List entries (projects, knowledge, sessions, distillations)
  data show <type> <id>         Show full detail for an entry
  data clear [options]          Clear data for a project or wipe the database
  data delete <type> <id>       Delete a single entry
  data merge <id1> <id2>        Merge two projects (moves data from id2 into id1)
  data recover                  Recover orphaned data from deleted projects

  Data flags: --project <path>, --limit <n>, --json, --yes/-y
  Clear flags: --knowledge, --temporal, --distillations, --all

Import options:
  --yes / -y                    Skip confirmation prompt
  --agent <name>                Import from specific agent only
                                (claude-code, codex, opencode, cline, continue, pi, aider)
  --project <path>              Target project (default: cwd)
  --dry-run                     Show what would be imported, no LLM calls

Agent arguments:
  Arguments after the agent name are forwarded to the launched agent:
    lore run claude --dangerously-skip-permissions
    lore claude --model gpt-4
  Without an agent name, unknown flags are forwarded to the auto-detected agent:
    lore --dangerously-skip-permissions
  Use -- to also forward flags that share names with lore's own options:
    lore -- --verbose --debug
    lore run -- --port 8080

Entity subcommands:
  entity list                                 List all entities with aliases
  entity show <id>                            Show full entity detail
  entity add <type> <name>                    Create a new entity
  entity alias add <id> --type <t> --value <v>  Add an alias to an entity
  entity alias rm <alias-id>                  Remove an alias
  entity merge <target-id> <source-id>        Merge two entities
  entity search <query>                       Search entities by name or alias
  entity delete <id>                          Delete an entity

  Entity types: person, org, service, tool, repo, infra
  Alias types: name, email, github, slack, phone, nickname, url, domain

Recall options:
  --project <path>              Target project (default: cwd)
  --scope <scope>               all (default), session, project, knowledge
  --session <id>                Session ID (for scope=session)
  --limit <n>                   Max results (default: 10)
  --json                        Output JSON instead of markdown

Account (login / whoami):
  --no-browser                  login: force the headless GitHub flow — show a
                                QR/URL and paste the code back. Auto-enabled
                                over SSH / headless / CI (env: LORE_NO_BROWSER=1)
  --email <address>             Sign in with an email OTP code instead of GitHub
                                (requires custom SMTP — not available on the
                                Supabase free tier's default email provider)
  --verify                      whoami: round-trip to the server to verify
                                the session is still valid
  --json                        whoami: also print account details as JSON

Examples:
  lore                          # Auto-detect agent and launch with gateway
  lore run claude               # Launch Claude Code through the gateway
  lore run opencode             # Launch OpenCode through the gateway
  lore --dangerously-skip-permissions          # Forward flags to auto-detected agent
  lore claude --dangerously-skip-permissions  # Forward flags to Claude Code
  lore run claude --model gpt-4              # Forward --model gpt-4 to claude
  lore -- --verbose --debug                  # Use -- to forward lore-like flags
  lore run --remote http://remote:3207  # Use a remote gateway
  lore start                    # Start gateway (hosted mode, FS ops disabled)
  lore start --bg               # Start gateway in the background, then exit
  lore stop                     # Stop a background gateway
  lore start --local            # Start gateway with FS ops enabled (local use)
  lore start -p 8080            # Start gateway on a custom port
  lore start -H 127.0.0.1 -H 100.69.65.125  # Bind to multiple interfaces
  lore start -H 127.0.0.1,100.69.65.125     # Same, comma-separated
  lore setup                    # Auto-detect and configure installed apps
  lore setup codex              # Configure Codex to use lore
  lore setup codex -r http://remote:3207  # Configure Codex with a remote gateway
  lore setup opencode --no-plugin  # Configure OpenCode without installing the @loreai/opencode plugin
  lore setup undo               # Undo setup for all configured apps
  lore setup undo claude-code   # Undo setup for Claude Code only
  lore setup status             # Show what setup has touched (read-only)
  lore doctor                   # Diagnose routing/env conflicts
  lore upgrade                  # Upgrade to latest version
  lore upgrade --check          # Check for updates without installing
  lore upgrade --force          # Force re-download even if up to date
  lore upgrade nightly          # Switch to nightly channel and update
  lore upgrade stable           # Switch back to stable channel
  lore upgrade 0.14.0           # Install a specific version
  lore upgrade --offline        # Upgrade from cached patches (no network)
  lore data list projects       # List all tracked projects
  lore data list knowledge      # List knowledge entries for current project
  lore data clear --project .   # Clear all data for the current project
  lore data clear --all         # Wipe the entire database
  lore import                   # Import knowledge from prior AI conversations
  lore import --dry-run         # Show what would be imported
  lore import --agent claude-code  # Import from Claude Code only
  lore logs                     # Show recent log entries
  lore logs -f                  # Follow log output in real-time
  lore logs -n 100              # Show last 100 lines
  lore logs --path              # Print log file path
  lore recall "error handling"  # Search project memory from CLI
  lore log                      # Recent knowledge changes in this project
  lore log <id>                 # Version timeline for one knowledge entry
  lore diff <id>                # What changed (latest superseded → current)
  lore login                    # Sign in to Folk Lore with GitHub (browser)
  lore login --no-browser       # Headless GitHub sign-in (SSH / remote box)
  lore login --email me@x.com   # Sign in with an email OTP code (needs SMTP)
  lore whoami                   # Show the signed-in account
  lore logout                   # Sign out
  lore sync enable              # Turn on cloud sync of knowledge + entities
  lore sync status              # Show sync state + pending local changes
  lore sync now                 # Push local changes then pull remote changes

Environment variables:
  LORE_LISTEN_PORT              Gateway port (overridden by --port)
  LORE_LISTEN_HOST              Gateway host(s), comma-separated (overridden by --host)
  LORE_UPSTREAM_ANTHROPIC       Upstream Anthropic API URL
  LORE_UPSTREAM_OPENAI          Upstream OpenAI API URL
  LORE_REMOTE_URL               Remote gateway URL for \`lore run\` (overridden by --remote)
  LORE_HOSTED_MODE              Hosted mode — disables FS ops on client-controlled paths
                                ON by default for \`lore start\`; set to 0 to disable
  LORE_REMOTE_GATEWAY           Remote-gateway mode — bucket path-less sessions per-session
                                ON by default for \`lore start\`; also auto-enabled when bind
                                address is non-loopback (e.g. Tailscale, LAN, 0.0.0.0)
  LORE_DEBUG                    Enable debug logging (1 or true)
  LORE_NO_UPDATE_CHECK          Disable background update checks (set to 1)
  SUPABASE_URL                  Override the Folk Lore Supabase project URL
  SUPABASE_ANON_KEY             Override the Supabase publishable key
`.trimStart();

export function printHelp(): void {
  console.log(USAGE);
}

export function printVersion(): void {
  console.log(VERSION);
}
