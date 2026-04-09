import { CheckIcon, CopyIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ensureEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface AllowedPubkey { pubkeyHex: string; npub: string; label: string | null; }

export function NostrDmSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const [pubkeys, setPubkeys] = useState<AllowedPubkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newPubkey, setNewPubkey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadPubkeys = useCallback(async () => {
    if (!environmentId) return;
    try {
      const api = ensureEnvironmentApi(environmentId);
      const result = await api.nostrDm.listAllowedPubkeys();
      setPubkeys(result ?? []);
    } catch (e) { console.error("Failed to load allowed pubkeys:", e); }
    finally { setLoading(false); }
  }, [environmentId]);

  useEffect(() => { void loadPubkeys(); }, [loadPubkeys]);

  const handleAdd = useCallback(async () => {
    if (!environmentId) return;
    const trimmed = newPubkey.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("npub1") && trimmed.length !== 64) { setAddError("Enter an npub (npub1...) or 64-character hex pubkey."); return; }
    setAddError(null);
    try {
      const api = ensureEnvironmentApi(environmentId);
      const labelValue = newLabel.trim();
      await api.nostrDm.addAllowedPubkey({ pubkey: trimmed, ...(labelValue ? { label: labelValue } : {}) });
      setNewPubkey(""); setNewLabel("");
      void loadPubkeys();
    } catch (e: any) { setAddError(e?.message ?? "Failed to add pubkey."); }
  }, [environmentId, newPubkey, newLabel, loadPubkeys]);

  const handleRemove = useCallback(async (pubkeyHex: string) => {
    if (!environmentId) return;
    try { const api = ensureEnvironmentApi(environmentId); await api.nostrDm.removeAllowedPubkey({ pubkeyHex }); void loadPubkeys(); }
    catch (e) { console.error("Failed to remove pubkey:", e); }
  }, [environmentId, loadPubkeys]);

  const handleCopy = useCallback((npub: string, pubkeyHex: string) => {
    navigator.clipboard.writeText(npub).then(() => { setCopiedId(pubkeyHex); setTimeout(() => setCopiedId(null), 2000); });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void handleAdd(); } }, [handleAdd]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Nostr DM Allowlist</h2>
          </div>
          <div className="px-5 py-4">
            <p className="mb-4 text-xs text-muted-foreground">Only these Nostr pubkeys can DM your thread npubs.</p>
            <div className="mb-4 flex flex-col gap-2">
              <div className="flex gap-2">
                <Input placeholder="npub1... or hex pubkey" value={newPubkey} onChange={(e) => { setNewPubkey(e.target.value); setAddError(null); }} onKeyDown={handleKeyDown} className="flex-1 font-mono text-xs" />
                <Input placeholder="Label (optional)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={handleKeyDown} className="w-40 text-xs" />
                <Button size="sm" variant="outline" onClick={() => void handleAdd()}><PlusIcon className="size-3.5" />Add</Button>
              </div>
              {addError && <p className="text-xs text-destructive">{addError}</p>}
            </div>
            {loading ? <p className="text-xs text-muted-foreground">Loading...</p>
              : pubkeys.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-6 text-center">
                  <p className="text-sm text-muted-foreground">No allowed pubkeys yet.</p>
                  <p className="mt-1 text-xs text-muted-foreground">Add your Nostr pubkey above to enable DMs.</p>
                </div>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {pubkeys.map((pk) => (
                    <div key={pk.pubkeyHex} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <code className="truncate text-xs text-foreground">{pk.npub}</code>
                          <button onClick={() => handleCopy(pk.npub, pk.pubkeyHex)} className="shrink-0 text-muted-foreground hover:text-foreground" title="Copy npub">
                            {copiedId === pk.pubkeyHex ? <CheckIcon className="size-3 text-green-500" /> : <CopyIcon className="size-3" />}
                          </button>
                        </div>
                        {pk.label && <p className="mt-0.5 text-[11px] text-muted-foreground">{pk.label}</p>}
                      </div>
                      <Button size="xs" variant="ghost" onClick={() => void handleRemove(pk.pubkeyHex)} className="shrink-0 text-muted-foreground hover:text-destructive"><TrashIcon className="size-3.5" /></Button>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </section>
      </div>
    </div>
  );
}
