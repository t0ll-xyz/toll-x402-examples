/**
 * Spending budgets: the payer wallet signs its own limits and sets them with Toll's facilitator.
 * After that, /verify and /settle refuse any payment past them, on every scheme (codes start with budget_).
 * Signing a budget moves no money.
 *
 *   npm run budget -- show
 *   npm run budget -- set --per-payment 0.05 --per-day 0.20 [--allow 0xSeller1,0xSeller2] [--days 7]
 *   npm run budget -- revoke
 *
 * Careful: a REVOKED budget refuses every payment from this payer through Toll's facilitator (budget_revoked),
 * until you sign a new budget with a higher nonce (`set` does that for you).
 *
 * EIP-712 domain "Toll Facilitator Budget" / "1" / chainId 4663, no verifyingContract. Amounts in USDG base units,
 * days in UTC. Spec: https://t0ll.xyz/llms.txt (x402 facilitator section).
 */
import { parseArgs } from "node:util";
import { getAddress, parseUnits, type Address, type Hex } from "viem";
import { FACILITATOR_URL, USDG, chainNow, payerAccount, signTyped, u, type Typed } from "./lib.js";

const BUDGET_URL = `${FACILITATOR_URL}/budget`;
const DOMAIN = { name: "Toll Facilitator Budget", version: "1", chainId: 4663 };
const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];
const BUDGET_TYPES = {
  EIP712Domain: DOMAIN_FIELDS,
  Budget: [
    { name: "payer", type: "address" },
    { name: "perPayment", type: "uint256" },
    { name: "perDay", type: "uint256" },
    { name: "perPayTo", type: "uint256" },
    { name: "payToCaps", type: "PayToCap[]" },
    { name: "allowedPayTos", type: "address[]" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  PayToCap: [
    { name: "payTo", type: "address" },
    { name: "perDay", type: "uint256" },
  ],
};
const REVOKE_TYPES = {
  EIP712Domain: DOMAIN_FIELDS,
  Revoke: [
    { name: "payer", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

type BudgetAnswer = {
  payer: string;
  day: string;
  budget: null | {
    perPayment: string;
    perDay: string;
    perPayTo: string;
    payToCaps?: { payTo: string; perDay: string }[];
    allowedPayTos?: string[];
    validUntil: string;
    nonce: string;
    revoked: boolean;
  };
  spentToday: string;
  remainingToday: string | null;
};

async function getBudget(payer: Address): Promise<BudgetAnswer> {
  const r = await fetch(`${BUDGET_URL}?payer=${payer.toLowerCase()}`);
  const j = (await r.json()) as BudgetAnswer & { error?: string };
  if (!r.ok) throw new Error(`GET /budget answered ${r.status} ${j.error ?? ""}`);
  return j;
}

async function postBudget(body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(BUDGET_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || j.ok !== true) throw new Error(`POST /budget refused: ${r.status} ${String(j.error ?? "")} ${String(j.message ?? "")}`);
  return j;
}

function show(g: BudgetAnswer) {
  const b = g.budget;
  if (!b) {
    console.log(`no budget for ${g.payer} · spent today (${g.day} UTC) ${u(g.spentToday)} USDG`);
    return;
  }
  console.log(
    [
      `payer ${g.payer}${b.revoked ? "  ** REVOKED: every payment is refused **" : ""}`,
      `  perPayment ${u(b.perPayment)} · perDay ${u(b.perDay)} · perPayTo ${b.perPayTo === "0" ? "-" : u(b.perPayTo)} USDG`,
      `  allowed payTos ${(b.allowedPayTos ?? []).join(", ") || "any"}`,
      `  valid until ${b.validUntil === "0" ? "no end" : new Date(Number(b.validUntil) * 1000).toISOString()} · nonce ${b.nonce}`,
      `  spent today ${u(g.spentToday)} · left today ${g.remainingToday === null ? "-" : u(g.remainingToday)} USDG`,
    ].join("\n"),
  );
}

/** a higher nonce replaces; a revoke needs one above the current budget's */
const nextNonce = (g: BudgetAnswer) => (g.budget ? BigInt(g.budget.nonce) + 1n : 1n).toString();

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "per-payment": { type: "string", default: "0.05" },
      "per-day": { type: "string", default: "0.20" },
      allow: { type: "string" },
      days: { type: "string", default: "7" },
    },
  });
  const cmd = positionals[0] ?? "show";
  const account = payerAccount();
  const payer = account.address;

  if (cmd === "show") {
    show(await getBudget(payer));
    return;
  }

  if (cmd === "set") {
    const current = await getBudget(payer);
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 0) throw new Error("--days must be a whole number (0 = no end)");
    const allowed = (values.allow ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((a) => getAddress(a).toLowerCase());
    const message = {
      payer: payer.toLowerCase(),
      perPayment: parseUnits(values["per-payment"]!, USDG.decimals).toString(),
      perDay: parseUnits(values["per-day"]!, USDG.decimals).toString(),
      perPayTo: "0",
      payToCaps: [] as { payTo: string; perDay: string }[],
      allowedPayTos: allowed,
      validUntil: days === 0 ? "0" : ((await chainNow()) + BigInt(days) * 86_400n).toString(),
      nonce: nextNonce(current),
    };
    const typed: Typed = { types: BUDGET_TYPES, primaryType: "Budget", domain: DOMAIN, message };
    const signature: Hex = await signTyped(account, typed);
    const r = await postBudget({ budget: message, signature });
    console.log(`budget stored · nonce ${String(r.nonce)}`);
    show(await getBudget(payer));
    return;
  }

  if (cmd === "revoke") {
    const current = await getBudget(payer);
    const message = { payer: payer.toLowerCase(), nonce: nextNonce(current) };
    const typed: Typed = { types: REVOKE_TYPES, primaryType: "Revoke", domain: DOMAIN, message };
    const signature = await signTyped(account, typed);
    await postBudget({ revoke: message, signature });
    console.log("revoked. Every payment from this payer is now refused until you `set` a new budget.");
    show(await getBudget(payer));
    return;
  }

  throw new Error(`unknown command "${cmd}": use show, set or revoke`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
