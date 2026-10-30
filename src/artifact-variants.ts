/**
 * Circuits bundled into the page, as "<inputs>x<outputs>". An unshield spends one or two notes and
 * creates the unshield output, plus a change note when sending less than the whole note. Fiber's
 * worker pre-warms 01x01 and 01x02 as its common shapes. Other shapes download on demand.
 */
export const BUNDLED_VARIANTS = ["01x01", "01x02", "02x01", "02x02"] as const;

/** Railgun's v2 circuits on IPFS, served with CORS by this gateway (Railgun's CDN isn't). */
export const ARTIFACT_GATEWAY = "https://ipfs-lb.com";
