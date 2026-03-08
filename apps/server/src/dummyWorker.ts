import { setTimeout as delay } from "node:timers/promises";

import { createLogger } from "./logger";

const logger = createLogger("dummy-worker");

const DEFAULT_HEARTBEAT_MS = 5_000;

const readHeartbeatMs = (): number => {
  const raw = process.env.DUMMY_WORKER_HEARTBEAT_MS;
  if (!raw) {
    return DEFAULT_HEARTBEAT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100) {
    logger.warn("Invalid heartbeat interval, falling back to default.", {
      env: "DUMMY_WORKER_HEARTBEAT_MS",
      received: raw,
      defaultMs: DEFAULT_HEARTBEAT_MS,
    });
    return DEFAULT_HEARTBEAT_MS;
  }

  return Math.floor(parsed);
};

const workerName = process.env.DUMMY_WORKER_NAME?.trim() || "dummy-worker";
const heartbeatMs = readHeartbeatMs();

let shuttingDown = false;
let heartbeatCount = 0;

const requestShutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info("Shutdown requested.", { signal, workerName, heartbeatCount });
};

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

const run = async (): Promise<void> => {
  logger.info("Worker started.", {
    pid: process.pid,
    workerName,
    heartbeatMs,
  });

  for (;;) {
    if (shuttingDown) {
      break;
    }
    heartbeatCount += 1;
    logger.event("Heartbeat.", {
      heartbeatCount,
      pid: process.pid,
      workerName,
    });
    await delay(heartbeatMs);
  }

  logger.info("Worker stopped.", {
    heartbeatCount,
    pid: process.pid,
    workerName,
  });
};

void run().catch((error: unknown) => {
  logger.error("Worker crashed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
