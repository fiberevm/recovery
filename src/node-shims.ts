// The Railgun engine and its leveldb store were written for Node and reach for these globals
// directly. This module must be imported before the engine so they exist when its modules evaluate.
import { Buffer } from "buffer";

type ProcessShim = {
  env: Record<string, string>;
  browser: boolean;
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
};

const scope = globalThis as unknown as {
  global?: typeof globalThis;
  Buffer?: typeof Buffer;
  process?: Partial<ProcessShim>;
};
scope.global ??= globalThis;
scope.Buffer ??= Buffer;
scope.process ??= {};
scope.process.env ??= {};
scope.process.browser ??= true;
scope.process.nextTick ??= (callback, ...args) => queueMicrotask(() => callback(...args));
