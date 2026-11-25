import { ApiRequestError, shopHeaderFor, toApiError } from './api';

/** The file name from a Content-Disposition header (`filename*=` wins over `filename=`), or the fallback. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name ? name : fallback;
}

/**
 * Fetch a file from our API and hand it to the browser as a download. Fetching first (instead of
 * navigating to the URL) means an API error is thrown as ApiRequestError, so the caller can show its
 * message, rather than the browser saving or showing the raw JSON error body.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'text/csv, application/json, */*', ...shopHeaderFor(path) },
    });
  } catch {
    throw new ApiRequestError({
      statusCode: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach RepairOS. Check your connection and try again.',
    });
  }
  if (!res.ok) throw new ApiRequestError(await toApiError(res));

  const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been handled; the browser keeps its own reference to the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
