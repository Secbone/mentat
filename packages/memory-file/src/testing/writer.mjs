import { commitMemory } from "../transaction.mjs";

for (let index = 0; index < 5; index++)
  commitMemory(process.argv[2], {
    text: `writer ${process.argv[3]} item ${index}`,
    speaker: "user",
    basis: "user",
  });
