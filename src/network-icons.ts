// Network icons drawn for this page: one 24×24 badge per chain in its brand colour, with a simple
// white mark. Keyed by RecoveryChain.slug. Static markup, so it's safe to set as innerHTML.

const badge = (fill: string, mark: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="${fill}"/>${mark}</svg>`;

export const NETWORK_ICONS: Record<string, string> = {
  // The octahedron: a light upper half over a darker lower facet.
  ethereum: badge(
    "#627EEA",
    `<path d="M12 4.2 7.4 12 12 14.7 16.6 12Z" fill="#fff"/><path d="M12 15.8 7.4 13.1 12 19.8 16.6 13.1Z" fill="#fff" fill-opacity=".72"/><path d="M12 4.2v10.5L16.6 12Z" fill="#fff" fill-opacity=".72"/>`,
  ),
  // A hexagon with two crossing strokes, after Arbitrum's mark.
  arbitrum: badge(
    "#213147",
    `<path d="M12 4.6 18.4 8.3v7.4L12 19.4 5.6 15.7V8.3Z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/><path d="m9.2 16.4 4.1-9.1M11.7 16.6l3.5-7.6" stroke="#28A0F0" stroke-width="1.7" stroke-linecap="round"/>`,
  ),
  // A disc with a slit from the left edge to the centre, after Base's mark.
  base: badge(
    "#0052FF",
    `<circle cx="12" cy="12" r="6.6" fill="#fff"/><rect x="4.9" y="11.15" width="7.4" height="1.7" rx=".4" fill="#0052FF"/>`,
  ),
  // A centre diamond with four small ones around it, after BNB's mark.
  bnb: badge(
    "#F0B90B",
    `<g fill="#fff"><path d="m12 8.9 3.1 3.1-3.1 3.1-3.1-3.1Z"/><path d="m12 4.3 2 2-2 2-2-2Z"/><path d="m12 15.7 2 2-2 2-2-2Z"/><path d="m6.3 10 2 2-2 2-2-2Z"/><path d="m17.7 10 2 2-2 2-2-2Z"/></g>`,
  ),
};

/** An inline icon element for a chain, or an empty span if none is drawn yet. */
export function networkIcon(slug: string): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "network-icon";
  icon.innerHTML = NETWORK_ICONS[slug] ?? "";
  return icon;
}
