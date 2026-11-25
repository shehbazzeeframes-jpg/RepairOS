import type { AnchorHTMLAttributes, Ref } from 'react';

/**
 * Link component for Astryx `Button`/`Link` `as=`: a plain `<a download>`, never Next's `<Link>`.
 * Next prefetches `<Link>` targets as soon as they render, which for an API download (the timesheet
 * CSV export, QA BUG-02) runs the export and writes an audit event without a click.
 */
export function DownloadAnchor({
  ref,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> }) {
  return <a ref={ref} {...props} download />;
}
