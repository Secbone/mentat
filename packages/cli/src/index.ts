import { benchCommand } from "./commands/bench";
import { chatCommand } from "./commands/chat";
import { evolveCommand } from "./commands/evolve";
import { harnessCommand } from "./commands/harness";
import { iterateCommand } from "./commands/iterate";
import { loopCommand } from "./commands/loop";
import { memoryCommand } from "./commands/memory";
import { runCommand } from "./commands/run";
import { traceCommand } from "./commands/trace";
import { USAGE } from "./usage";

export { createDefaultRegistry } from "./lib/registry";

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "bench":
      return benchCommand(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "harness":
      return harnessCommand(rest);
    case "run":
      return runCommand(rest);
    case "chat":
      return chatCommand(rest);
    case "loop":
      return loopCommand(rest);
    case "memory":
      return memoryCommand(rest);
    case "evolve":
      return evolveCommand(rest);
    case "iterate":
      return iterateCommand(rest);
    case "trace":
      return traceCommand(rest);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}
