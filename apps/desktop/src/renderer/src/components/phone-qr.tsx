import type { PhoneStatus } from '@aic/ipc';
import { Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { invoke } from '../lib/api';
import { errorMessage } from '../lib/utils';
import { useApp } from '../store';
import { Button } from './ui/button';

/** A QR code for the phone to scan, with the link and who's connected. */
export function PhoneQr({ status }: { status: PhoneStatus }) {
  const toast = useApp((s) => s.toast);
  const [svg, setSvg] = useState<string | null>(null);
  const url = status.urls[0];

  useEffect(() => {
    if (!url) return;
    let alive = true;
    void QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (s) => alive && setSvg(s),
    );
    return () => {
      alive = false;
    };
  }, [url]);

  if (!url) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {status.error ?? 'No network connection found. Connect this computer to Wi-Fi first.'}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-5" data-testid="phone-qr">
      <div
        className="size-40 shrink-0 rounded-lg bg-white p-2"
        // Our own QR library's SVG for our own link.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        aria-label="QR code for your phone"
        role="img"
      />
      <div className="min-w-0 space-y-2 text-[13px]">
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Connect your phone to the same Wi-Fi as this computer.</li>
          <li>Open the camera and scan the code, then open the link.</li>
          <li>Keep the phone's screen on during the interview.</li>
        </ol>
        <p className="flex items-center gap-1.5 font-medium" data-testid="phone-clients">
          <Smartphone className="size-3.5" aria-hidden />
          {status.clients === 0
            ? 'No phone connected yet'
            : `${status.clients} phone${status.clients === 1 ? '' : 's'} connected`}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2"
          onClick={() =>
            void invoke('app:copyText', url)
              .then(() => toast('success', 'Link copied.'))
              .catch((err: unknown) => toast('error', errorMessage(err)))
          }
        >
          Copy link
        </Button>
        <span className="sr-only" data-testid="phone-url">
          {url}
        </span>
      </div>
    </div>
  );
}
