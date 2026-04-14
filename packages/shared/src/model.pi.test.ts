import { describe, expect, it } from "vitest";

import { normalizeProviderModelOptionsWithCapabilities } from "./model";
import type { ModelCapabilities } from "@t3tools/contracts";

const piReasoningCapabilities: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

describe("normalizeProviderModelOptionsWithCapabilities", () => {
  it("preserves supported pi thinking levels", () => {
    expect(
      normalizeProviderModelOptionsWithCapabilities("pi", piReasoningCapabilities, {
        thinkingLevel: "high",
      }),
    ).toEqual({ thinkingLevel: "high" });
  });

  it("falls back to the pi default thinking level", () => {
    expect(
      normalizeProviderModelOptionsWithCapabilities("pi", piReasoningCapabilities, {
        thinkingLevel: "xhigh",
      }),
    ).toEqual({ thinkingLevel: "medium" });
  });
});
