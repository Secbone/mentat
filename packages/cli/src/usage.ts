export const USAGE = `mentat — a self-iterating agent framework

Usage:
  mentat harness list
  mentat run "<prompt>" [--harness <id>] [--model <id>] [--cwd <path>] [--memory <file>] [--remember "<fact>"]... [--reflect] [--experience <dir>] [--permission <ask|auto|full>]
  mentat chat [--harness <id>] [--model <id>] [--cwd <path>] [--memory <file>] [--experience <dir>] [--permission <ask|auto|full>]
  mentat loop demo|memory
  mentat memory migrate [--memory <file>] [--snapshot <file>] [--audit <file>]
  mentat evolve memory --queries <file> (--facts <file> | --agent [--from-experience] [--experience <dir>] [--recent <n>]) [--model <id>] [--store <dir>] [--memory <file>] [--iterations <n>]
  mentat iterate --target <dir> --task "<goal>" --check "<cmd>" [--eval "<cmd>"]
  mentat trace [<run-dir>] [--raw]
  mentat help

Options:
  --harness <id>       harness adapter to use (default: fake)
  --model <id>         model id passed to the harness
  --cwd <path>         working directory (default: process.cwd())
  --permission <mode>  ask | auto | full (default: auto)
  --yes                shorthand for --permission full

iterate options:
  --target <dir>       git repo the agent edits (default: process.cwd())
  --task "<goal>"      what the agent should achieve (required)
  --check "<cmd>"      gate + default evaluator: pass=1, fail=0 (required unless --eval)
  --eval "<cmd>"       evaluator command printing a Signal[] JSON array on stdout
  --iterations <n>     how many iterations to attempt (default: 1)
  --protect <glob>     被保护的路径，禁止 agent 修改（可重复；默认 packages/core/src/loop/**）
  --from-experience    feed a digest of recent experiences into the proposer

  --experience <dir>   experience store directory (default: .mentat/experience)
  --recent <n>         how many recent experiences to feed (default: 20)

ACP harness:
  Set MENTAT_ACP_BIN to an ACP agent binary (e.g. an opencode build) to expose the
  "acp" harness. Optional MENTAT_ACP_ARGS (space-separated) override the default "acp".
`;
