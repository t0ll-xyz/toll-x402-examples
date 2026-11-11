import { ExactEvmScheme } from "@x402/evm/exact/server";

/** Toll's facilitator. Keyless, no fee, pays the gas. */
export const FACILITATOR_URL = "https://x402.t0ll.xyz";

/** Robinhood Chain (CAIP-2). */
export const ROBINHOOD = "eip155:4663";

/** USDG ("Global Dollar") on Robinhood Chain. Same values as GET https://x402.t0ll.xyz/supported. */
export const USDG = {
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  decimals: 6,
  name: "Global Dollar",
  version: "1",
} as const;

/** The ERC-8004 identity registry on Robinhood Chain. */
export const ERC8004_REGISTRY = "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** "0.01" -> "10000" (USDG has 6 decimals). */
export function toUsdgUnits(price: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new Error(`price must be a decimal with at most 6 decimals, got "${price}"`);
  return (BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

/**
 * The official exact scheme, taught that "$0.01" on Robinhood Chain means 0.01 USDG.
 *
 * @x402/evm 2.30.0 has no default asset for eip155:4663 yet. USDG was added upstream
 * (x402-foundation/x402#4207, merged 2026-11-10) and ships in the next @x402/evm release.
 * After that this parser is not needed, and plain `new ExactEvmScheme()` works.
 */
export function usdgExactScheme(): ExactEvmScheme {
  return new ExactEvmScheme().registerMoneyParser(async (amount, network) => {
    if (network !== ROBINHOOD) return null;
    return {
      asset: USDG.address,
      amount: toUsdgUnits(String(amount)),
      extra: { name: USDG.name, version: USDG.version },
    };
  });
}

/** The seller settings from the environment. Fails at startup, not on the first buyer. */
export function sellerEnv() {
  const payTo = process.env.PAY_TO ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("Set PAY_TO to the 0x wallet that gets paid (see .env.example)");
  const agentId = process.env.AGENT_ID?.trim() || undefined;
  const port = Number(process.env.PORT || 4021);
  // With an agent id the facilitator checks that payTo is that identity's agent wallet (ERC-8478).
  const extra = agentId ? { erc8004: { registry: ERC8004_REGISTRY, agentId } } : undefined;
  return { payTo, agentId, port, extra };
}
