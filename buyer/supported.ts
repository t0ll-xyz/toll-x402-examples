/**
 * What Toll's facilitator settles right now: schemes, the USDG asset, contracts and signers.
 * Free, read-only.  npm run supported
 */
import { FACILITATOR_URL } from "./lib.js";

const r = await fetch(`${FACILITATOR_URL}/supported`);
const j = (await r.json()) as { kinds: { x402Version: number; scheme: string; network: string; extra?: unknown }[]; extensions?: string[] };
for (const k of j.kinds) {
  console.log(`v${k.x402Version} ${k.scheme.padEnd(16)} ${k.network}${k.extra ? `  ${JSON.stringify(k.extra)}` : ""}`);
}
console.log(`extensions: ${(j.extensions ?? []).join(", ")}`);
