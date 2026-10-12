import { describeHarnessContract } from "@mentat/core/testing";
import { createFakeAdapter } from "./fake";

describeHarnessContract("fake", () => createFakeAdapter());
