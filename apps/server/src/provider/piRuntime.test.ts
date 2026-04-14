import { describe, expect, it } from "vitest";

import {
  EMPTY_PI_MODEL_CAPABILITIES,
  PI_REASONING_MODEL_CAPABILITIES,
  parsePiDotEnv,
  resolvePiModelTarget,
} from "./piRuntime.ts";

describe("parsePiDotEnv", () => {
  it("parses common dotenv syntax", () => {
    expect(
      parsePiDotEnv(
        [
          "# comment",
          "OPENAI_API_KEY=base-key",
          "export ANTHROPIC_API_KEY='anthropic-key'",
          'GOOGLE_API_KEY="line1\\nline2"',
          "INVALID LINE",
          "EMPTY=",
          "TRAILING=value # comment",
        ].join("\n"),
      ),
    ).toEqual({
      OPENAI_API_KEY: "base-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      GOOGLE_API_KEY: "line1\nline2",
      EMPTY: "",
      TRAILING: "value",
    });
  });
});

describe("Pi reasoning capabilities", () => {
  it("exposes Pi thinking levels for reasoning-capable models", () => {
    expect(PI_REASONING_MODEL_CAPABILITIES.reasoningEffortLevels).toEqual([
      { value: "off", label: "Off" },
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium", isDefault: true },
      { value: "high", label: "High" },
    ]);
    expect(EMPTY_PI_MODEL_CAPABILITIES.reasoningEffortLevels).toEqual([]);
  });
});

describe("resolvePiModelTarget", () => {
  it("resolves provider/model inputs directly", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "openai/gpt-5.4",
        availableModels: [],
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("resolves exact model ids from available Pi models", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "gpt-5.4",
        availableModels: [{ id: "gpt-5.4", provider: "openai" }],
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("accepts duplicated exact ids by choosing the first matching provider", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "gpt-5.4",
        availableModels: [
          { id: "gpt-5.4", provider: "openai" },
          { id: "gpt-5.4", provider: "openrouter" },
        ],
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("falls back to the single available provider for bare ids", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "gpt-5.4",
        availableModels: [{ id: "gpt-5.3", provider: "openai" }],
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("falls back to an explicit provider hint when model discovery is ambiguous", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "gpt-5.4",
        availableModels: [
          { id: "other-model", provider: "openai" },
          { id: "different-model", provider: "openrouter" },
        ],
        fallbackProvider: "openai",
      }),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("ignores unknown provider placeholders", () => {
    expect(
      resolvePiModelTarget({
        requestedModel: "gpt-5.4",
        availableModels: [{ id: "gpt-5.4", provider: "unknown" }],
        fallbackProvider: "unknown",
      }),
    ).toBeNull();
  });
});
