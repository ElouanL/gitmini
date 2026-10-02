// Paperboard (front only, 03: "copy-* → clipboard").
import { t } from '../i18n/index';
import { toast } from './stores/toast.svelte';

export async function copyText(text: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  let ok: boolean;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fold: Selection of a hidden textarea (WebView without API Asynchronous Clipboard).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {
      ok = false;
    }
  }
  if (!opts.silent) {
    if (ok) toast.success(t('toast.copied'));
    else toast.error(t('toast.copyFailed'));
  }
  return ok;
}
