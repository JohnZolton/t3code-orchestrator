import { type ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { memo, useCallback, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCodeIcon, CopyIcon, CheckIcon, XIcon, LoaderIcon, SmartphoneIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { ensureEnvironmentApi } from "../../environmentApi";

interface ThreadNpubQRProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}

export const ThreadNpubQR = memo(function ThreadNpubQR({ environmentId, threadId }: ThreadNpubQRProps) {
  const [open, setOpen] = useState(false);
  const [npub, setNpub] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const ensureNpub = useCallback(async () => {
    if (npub) return npub;
    const api = ensureEnvironmentApi(environmentId);
    const result = await api.nostrDm.getThreadNpub({ threadId });
    if (result?.npub) { setNpub(result.npub); return result.npub as string; }
    return null;
  }, [environmentId, threadId, npub]);

  const handleSendDm = useCallback(async () => {
    setSending(true);
    try {
      // Always call the server — even if we have the npub cached, the server
      // needs to activate the thread and send the initial DM each time.
      const api = ensureEnvironmentApi(environmentId);
      const result = await api.nostrDm.getThreadNpub({ threadId });
      if (result?.npub) { setNpub(result.npub); }
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    }
    catch (e) { console.error("Failed to send thread DM:", e); }
    finally { setSending(false); }
  }, [environmentId, threadId]);

  const handleToggleQR = useCallback(async () => {
    if (open) { setOpen(false); return; }
    setLoading(true);
    try { await ensureNpub(); setOpen(true); }
    catch (e) { console.error("Failed to get thread npub:", e); }
    finally { setLoading(false); }
  }, [open, ensureNpub]);

  const handleCopy = useCallback(() => {
    if (!npub) return;
    navigator.clipboard.writeText(npub).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [npub]);

  return (
    <div className="relative flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={
          <Toggle className="shrink-0" pressed={sent} onPressedChange={handleSendDm} aria-label="Send thread to phone via Nostr DM" variant="outline" size="xs" disabled={sending}>
            {sending ? <LoaderIcon className="size-3 animate-spin" /> : sent ? <CheckIcon className="size-3 text-green-500" /> : <SmartphoneIcon className="size-3" />}
          </Toggle>
        } />
        <TooltipPopup side="bottom">{sending ? "Sending..." : sent ? "Sent to phone!" : "Send thread to phone"}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Toggle className="shrink-0" pressed={open} onPressedChange={handleToggleQR} aria-label="Show thread QR code" variant="outline" size="xs" disabled={loading}>
            <QrCodeIcon className="size-3" />
          </Toggle>
        } />
        <TooltipPopup side="bottom">{loading ? "Generating..." : "QR code"}</TooltipPopup>
      </Tooltip>
      {open && npub && (
        <div className="absolute right-0 top-full z-50 mt-2 rounded-lg border border-border bg-popover p-4 shadow-lg">
          <div className="flex items-center justify-between gap-2 pb-3">
            <span className="text-xs font-medium text-muted-foreground">Scan to DM this thread</span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><XIcon className="size-3.5" /></button>
          </div>
          <div className="rounded-md bg-white p-3"><QRCodeSVG value={npub} size={180} level="M" marginSize={1} /></div>
          <div className="mt-3 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">{npub}</code>
            <button onClick={handleCopy} className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" title="Copy npub">
              {copied ? <CheckIcon className="size-3.5 text-green-500" /> : <CopyIcon className="size-3.5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
