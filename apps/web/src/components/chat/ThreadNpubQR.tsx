import { type ThreadId, WS_METHODS, type ThreadNpubInfo } from "@t3tools/contracts";
import { memo, useCallback, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCodeIcon, CopyIcon, CheckIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { createWsNativeApi } from "../../wsNativeApi";

interface ThreadNpubQRProps {
  threadId: ThreadId;
}

/**
 * Button that fetches/generates a Nostr npub for the thread
 * and shows it as a QR code in a popover.
 */
export const ThreadNpubQR = memo(function ThreadNpubQR({ threadId }: ThreadNpubQRProps) {
  const [open, setOpen] = useState(false);
  const [npub, setNpub] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleToggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }

    setLoading(true);
    try {
      const api = createWsNativeApi();
      const result = await (api as any).nostrDm.getThreadNpub({ threadId });
      if (result?.npub) {
        setNpub(result.npub);
        setOpen(true);
      }
    } catch (e) {
      console.error("Failed to get thread npub:", e);
    } finally {
      setLoading(false);
    }
  }, [threadId, open]);

  const handleCopy = useCallback(() => {
    if (!npub) return;
    navigator.clipboard.writeText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [npub]);

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0"
              pressed={open}
              onPressedChange={handleToggle}
              aria-label="Show thread Nostr DM QR code"
              variant="outline"
              size="xs"
              disabled={loading}
            >
              <QrCodeIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {loading ? "Generating npub..." : "Nostr DM QR code"}
        </TooltipPopup>
      </Tooltip>

      {open && npub && (
        <div className="absolute right-0 top-full z-50 mt-2 rounded-lg border border-border bg-popover p-4 shadow-lg">
          <div className="flex items-center justify-between gap-2 pb-3">
            <span className="text-xs font-medium text-muted-foreground">DM this thread</span>
            <button
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>

          <div className="rounded-md bg-white p-3">
            <QRCodeSVG value={npub} size={180} level="M" marginSize={1} />
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
              {npub}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
              title="Copy npub"
            >
              {copied ? (
                <CheckIcon className="size-3.5 text-green-500" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
