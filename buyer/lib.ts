/**
 * Shared bits for the buyer scripts: constants, env, clients and small helpers.
 * Every value here is public (the same as GET https://x402.t0ll.xyz/supported).
 */
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood } from "viem/chains";

export const FACILITATOR_URL = "https://x402.t0ll.xyz";
export const NETWORK = "eip155:4663" as const;
export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** USDG ("Global Dollar") on Robinhood Chain: EIP-3009, 6 decimals. */
export const USDG = {
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  decimals: 6,
  name: "Global Dollar",
  version: "1",
} as const;

/** Uniswap's canonical Permit2 (same address on every chain). */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/** Nothing moves on chain unless SETTLE=1. Without it the scripts sign and call /verify only. */
export const SETTLE = process.env.SETTLE === "1";

// ------------------------------------------------------------------------------------------------ env

function keyFrom(name: string): Hex {
  const v = (process.env[name] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`Set ${name} in .env to a 0x private key of a THROWAWAY wallet with a few cents (see .env.example)`);
  }
  return v as Hex;
}

/** The payer: a throwaway wallet, from PAYER_KEY only. */
export function payerAccount(): PrivateKeyAccount {
  return privateKeyToAccount(keyFrom("PAYER_KEY"));
}

/** The seller (escrow.ts, batch refund): from SELLER_KEY only. */
export function sellerAccount(): PrivateKeyAccount {
  return privateKeyToAccount(keyFrom("SELLER_KEY"));
}

/** Who the direct-to-facilitator scripts pay. Never the payer itself. */
export function payToFor(payer: Address): Address {
  const v = (process.env.PAY_TO_FOR_BUYER ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Set PAY_TO_FOR_BUYER in .env to another wallet you control (it receives the test payments)");
  if (v.toLowerCase() === payer.toLowerCase()) throw new Error("PAY_TO_FOR_BUYER must not be the payer wallet");
  return getAddress(v);
}

/** The most one payment may be, in USDG base units (MAX_USDG, default 0.05). */
export function maxUnits(): bigint {
  return parseUnits(process.env.MAX_USDG?.trim() || "0.05", USDG.decimals);
}

/** A USDG decimal ("0.01") as base units, refused above MAX_USDG. */
export function usdgUnits(decimal: string, what = "amount"): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal)) throw new Error(`${what} must be a USDG decimal like 0.01, got "${decimal}"`);
  const v = parseUnits(decimal, USDG.decimals);
  if (v <= 0n) throw new Error(`${what} must be above 0`);
  if (v > maxUnits()) throw new Error(`${what} ${decimal} USDG is above MAX_USDG (${u(maxUnits())}). Raise MAX_USDG only if you mean it.`);
  return v;
}

/** base units -> "0.01" */
export const u = (x: bigint | string | number) => formatUnits(BigInt(x), USDG.decimals);

// ------------------------------------------------------------------------------------------------ chain

const transport = http(process.env.RPC_URL?.trim() || undefined);
export const publicClient = createPublicClient({ chain: robinhood, transport });
export const walletFor = (account: PrivateKeyAccount) => createWalletClient({ account, chain: robinhood, transport });

/** The chain's clock (unix seconds). Use it for deadlines, not the laptop's clock. */
export async function chainNow(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

export const txLink = (tx: string) => `${EXPLORER}/tx/${tx}`;

/** 32 random bytes as 0x hex */
export function rand(n = 32): Hex {
  return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex")}` as Hex;
}

// ------------------------------------------------------------------------------------------------ facilitator

type Kind = { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> };

/** GET /supported, then the v2 kind for `scheme` on Robinhood Chain (throws when it is off). */
export async function supportedKind(scheme: string): Promise<Kind> {
  const r = await fetch(`${FACILITATOR_URL}/supported`);
  if (!r.ok) throw new Error(`GET /supported answered ${r.status}`);
  const j = (await r.json()) as { kinds?: Kind[] };
  const k = (j.kinds ?? []).find((x) => x.x402Version === 2 && x.scheme === scheme && x.network === NETWORK);
  if (!k) throw new Error(`The facilitator does not list ${scheme} on ${NETWORK} right now (GET ${FACILITATOR_URL}/supported)`);
  return k;
}

/** POST a raw x402 body to /verify or /settle and return the JSON answer, whatever the status. */
export async function post(path: "/verify" | "/settle", body: unknown): Promise<Record<string, any>> {
  const r = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return (await r.json()) as Record<string, any>;
  } catch {
    return { success: false, isValid: false, errorReason: `http_${r.status}`, invalidReason: `http_${r.status}` };
  }
}

/** POST /settle, asking again while the answer is settlement_pending (the same body is safe to resend). */
export async function settleRaw(body: unknown): Promise<Record<string, any>> {
  let s = await post("/settle", body);
  for (let i = 0; i < 6 && !s.success && s.errorReason === "settlement_pending"; i++) {
    console.log("  pending, asking again in 10 s ...");
    await new Promise((r) => setTimeout(r, 10_000));
    s = await post("/settle", body);
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ EIP-712

/** A typed-data object in the JSON shape the facilitator and wallets use (numbers as decimal strings). */
export type Typed = {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};

/** Convert the JSON-shaped message to what viem signs (uints as bigint), then sign it. */
export async function signTyped(account: PrivateKeyAccount, t: Typed): Promise<Hex> {
  const { EIP712Domain: _drop, ...types } = t.types;
  const conv = (type: string, v: unknown): unknown => {
    if (type.endsWith("[]")) return (v as unknown[]).map((x) => conv(type.slice(0, -2), x));
    if (/^u?int\d*$/.test(type)) return BigInt(v as string);
    const fields = types[type];
    if (fields) return Object.fromEntries(fields.map((f) => [f.name, conv(f.type, (v as Record<string, unknown>)[f.name])]));
    return v;
  };
  // The shapes are only known at runtime here, so the call is typed loosely on purpose.
  const sign = account.signTypedData as (p: { domain: unknown; types: unknown; primaryType: string; message: unknown }) => Promise<Hex>;
  return sign({ domain: t.domain, types, primaryType: t.primaryType, message: conv(t.primaryType, t.message) });
}
