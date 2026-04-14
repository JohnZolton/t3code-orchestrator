import type { PiSettings, ServerProvider } from "@t3tools/contracts";
import { Cause, Effect, Equal, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { probePiModels, EMPTY_PI_MODEL_CAPABILITIES } from "../piRuntime.ts";
import { PiProvider } from "../Services/PiProvider.ts";

const PROVIDER = "pi" as const;

function checkPiProviderStatus(input: {
  readonly settings: PiSettings;
  readonly cwd: string;
}): Effect.Effect<ServerProvider> {
  const checkedAt = new Date().toISOString();

  const fallback = (cause: unknown) => {
    const installed = !isCommandMissingCause(cause);
    const detail = cause instanceof Error ? cause.message : undefined;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: input.settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], PROVIDER, [], EMPTY_PI_MODEL_CAPABILITIES),
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: detail ?? (installed ? "Failed to probe Pi RPC." : "Pi CLI not found on PATH."),
      },
    });
  };

  return Effect.gen(function* () {
    if (!input.settings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings([], PROVIDER, [], EMPTY_PI_MODEL_CAPABILITIES),
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    const modelsExit = yield* Effect.exit(
      Effect.tryPromise(() =>
        probePiModels({
          binaryPath: input.settings.binaryPath,
          cwd: input.cwd,
        }),
      ),
    );
    if (modelsExit._tag === "Failure") {
      return fallback(Cause.squash(modelsExit.cause));
    }

    const models = providerModelsFromSettings(
      modelsExit.value,
      PROVIDER,
      [],
      EMPTY_PI_MODEL_CAPABILITIES,
    );
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: "unknown", type: "pi" },
        message:
          models.length > 0
            ? `Pi RPC is available with ${models.length} model${models.length === 1 ? "" : "s"}.`
            : "Pi RPC is available, but it did not report any models.",
      },
    });
  });
}

export function makePiProviderLive() {
  return Layer.effect(
    PiProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;

      const getProviderSettings = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.pi),
      );

      return yield* makeManagedServerProvider<PiSettings>({
        getSettings: getProviderSettings.pipe(Effect.orDie),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.map((settings) => settings.providers.pi),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        checkProvider: getProviderSettings.pipe(
          Effect.flatMap((settings) =>
            checkPiProviderStatus({
              settings,
              cwd: serverConfig.cwd,
            }),
          ),
        ),
      });
    }),
  );
}

export const PiProviderLive = makePiProviderLive();
