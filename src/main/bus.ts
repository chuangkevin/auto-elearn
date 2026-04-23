import { EventEmitter } from "node:events";

export interface BusEvents {
  log: [level: "info" | "warn" | "error", msg: string];
  state: [];
}

export function createBus() {
  const ee = new EventEmitter();
  return {
    emit<K extends keyof BusEvents>(ev: K, ...args: BusEvents[K]) {
      ee.emit(ev, ...args);
    },
    on<K extends keyof BusEvents>(ev: K, fn: (...args: BusEvents[K]) => void) {
      ee.on(ev, fn as (...a: unknown[]) => void);
    },
  };
}

export type Bus = ReturnType<typeof createBus>;
