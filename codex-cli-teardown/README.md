# Codex CLI Teardown / OpenAI Codex 源码级拆解

A source-level technical teardown of [openai/codex](https://github.com/openai/codex) — OpenAI's open-source coding agent. This is the second deep-dive in the Lumina series, after the Claude Code teardown.

对 OpenAI 开源编码 Agent **Codex** 的源码级技术拆解。Lumina 系列的第二个深度拆解（第一个是 Claude Code）。

## Why this teardown

The interesting question is not "what does Codex do" — it's "what did Codex's authors decide *differently* from Claude Code's authors, given they were solving the same problem?"

有意思的问题不是"Codex 做了什么"，而是"在解决同一个问题时，Codex 的作者和 Claude Code 的作者的选择有什么不同？"

Both are coding agents. Both run locally. Both expose tools and consume LLM streams. Yet the architectural decisions diverge sharply — and those divergences encode opinions worth understanding.

## Chapter Structure

| Chapter | Topic | Why it gets its own chapter |
|---------|-------|------------------------------|
| ch00 | Architecture Overview — the Rust+JS split | Codex puts core in Rust; Claude Code is end-to-end TS. This shapes everything. |
| ch01 | Core Engine — `submission_loop`, channel-based event protocol | Direct comparison to Claude Code's `queryLoop` AsyncGenerator. |
| ch02 | Tools & MCP — `ToolHandler` trait, MCP integration | Same problem as Claude Code, different language → different abstraction. |
| ch03 | Native Sandboxing — Landlock + Bubblewrap + Windows Restricted Token | **Codex-unique**: Claude Code has no native OS-level sandboxing. |
| ch04 | Batch Jobs & Goals — map-reduce sub-agents + autonomous continuation | **Codex-unique**: native concurrency primitives Claude Code lacks. |

## Source

Codex source cloned to `C:/Users/Administrator/Desktop/codex-source/` (sibling directory, not committed).
Pinned commit: see `SOURCE_COMMIT.txt`.

## Status

- [x] Repo cloned, architecture mapped
- [x] Skeleton scaffolded
- [ ] ch01 script.md drafted
- [ ] ch00–ch04 scripts complete
- [ ] Slides authored
- [ ] Lumina build pipeline generalized to support multiple projects
