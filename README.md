<!-- OSS_WEEKEND_START -->
# OSS Weekend

**Issue tracker reopens Monday, April 13, 2026.**

OSS weekend runs Thursday, April 2, 2026 through Monday, April 13, 2026. New issues and PRs from unapproved contributors are auto-closed during this time. Approved contributors can still open issues and PRs if something is genuinely urgent, but please keep that to pressing matters only. For support, join [Discord](https://discord.com/invite/3cU7Bz4UPx).

> _Current focus: at the moment i'm deep in refactoring internals, and need to focus._
<!-- OSS_WEEKEND_END -->

---

# OXI Monorepo

> **Looking for the oxipi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Share your OSS coding agent sessions

If you use oxipi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

To publish sessions, use [`a7garden/oxipi-share-hf`](https://github.com/a7garden/oxipi-share-hf).

## Packages

| Package | Description |
|---------|-------------|
| **[@oxipi/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@oxipi/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@oxipi/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@oxipi/mom](packages/mom)** | Slack bot that delegates messages to the oxipi coding agent |
| **[@oxipi/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@oxipi/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@oxipi/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./oxipi-test.sh      # Run oxipi from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
