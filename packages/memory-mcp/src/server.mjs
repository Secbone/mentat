#!/usr/bin/env node
// Workspace TypeScript implementation; loader is an explicit runtime dependency.
import { register } from "tsx/esm/api";

register();
await import("./server-main.mjs");
