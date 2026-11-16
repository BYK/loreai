/** Keep the deployment path and field anchor. Drop credentials and filters before sharing. */
export function referenceShareLink(currentHref: string, slug: string): string {
  const url = new URL(currentHref);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = slug;
  return url.href;
}
