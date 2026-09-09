/**
 * Network constants the port-forwarding and ssh-config code shares.
 *
 * These literals were spelled out at a dozen sites (the port ceiling alone
 * appeared as `65535` in four files and `65536` in a fifth); naming them is
 * what lets a reader trust that every validator uses the same ceiling.
 */

/** The inclusive top of the TCP port range. */
export const MAX_PORT = 65_535;

/**
 * The loopback the tunnels bind. The remote side of a `-L`-style forward and
 * the local listener both mean THIS address.
 */
export const LOOPBACK_HOST = '127.0.0.1';
