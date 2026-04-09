import { createFileRoute } from "@tanstack/react-router";

import { NostrDmSettingsPanel } from "../components/settings/NostrDmSettingsPanel";

export const Route = createFileRoute("/settings/nostr")({
  component: NostrDmSettingsPanel,
});
