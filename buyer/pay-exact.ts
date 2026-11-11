/**
 * Pay an x402 API with USDG on Robinhood Chain (scheme "exact", EIP-3009), with the official @x402 client.
 *
 *   npm run exact                       dry run: read the 402, sign, ask Toll's /verify. Nothing moves.
 *   SETTLE=1 npm run exact              pay for real and print the answer + the settlement.
 *
 * TARGET_URL is the paid URL (default: the local seller example, http://localhost:4021/weather).
 * Any x402 seller that takes USDG on eip155:4663 works, for example https://t0ll.xyz/api/x402/pulse (0.01 USDG).
 * MAX_USDG caps one payment (default 0.05). Use a throwaway wallet with a few cents.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { VerifyError } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { FACILITATOR_URL, NETWORK, SETTLE, USDG, maxUnits, payerAccount, txLink, u } from "./lib.js";

async function main(): Promise<void> {
  const url = process.env.TARGET_URL?.trim() || "http://localhost:4021/weather";
  const account = payerAccount();

  // The official client, for Robinhood Chain only. @x402/evm 2.30.0 does not know USDG as a default asset yet
  // (added upstream in x402-foundation/x402#4207, in the next release), so it is allowed here by address, with a cap.
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(account))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDG.address, maxAmountPerPayment: maxUnits().toString() }] });

  console.log(`payer ${account.address}\nGET ${url}`);
  const first = await fetch(url);
  const header = first.headers.get("PAYMENT-REQUIRED");
  if (first.status !== 402 || !header) {
    console.log(`answered ${first.status} without an x402 v2 PAYMENT-REQUIRED header: nothing to pay`);
    process.exitCode = 1;
    return;
  }
  const required = decodePaymentRequiredHeader(header);
  for (const a of required.accepts) console.log(`  offers ${a.scheme} ${a.network} amount ${a.amount} asset ${a.asset} payTo ${a.payTo}`);
  const mine = required.accepts.find((a) => a.network === NETWORK && a.asset.toLowerCase() === USDG.address.toLowerCase());
  if (!mine) {
    console.log("  no USDG option on Robinhood Chain in this 402");
    process.exitCode = 1;
    return;
  }
  console.log(`  -> pays ${u(mine.amount)} USDG to ${mine.payTo}`);

  if (!SETTLE) {
    // Sign the payment the client would send, and let Toll's facilitator check it. /verify moves nothing.
    const payment = await client.createPaymentPayload(required);
    try {
      const v = await new HTTPFacilitatorClient({ url: FACILITATOR_URL }).verify(payment, payment.accepted);
      console.log(`  /verify: ${v.isValid ? "valid" : `not valid: ${v.invalidReason}`}`);
    } catch (e) {
      if (e instanceof VerifyError) console.log(`  /verify: not valid: ${e.invalidReason} ${e.invalidMessage ?? ""}`);
      else throw e;
    }
    console.log("dry run: nothing was paid. Run with SETTLE=1 to pay.");
    return;
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment(url);
  console.log(`answered ${res.status}`);
  console.log(await res.text());
  const paid = res.headers.get("PAYMENT-RESPONSE");
  if (paid) {
    const s = decodePaymentResponseHeader(paid);
    console.log(`settled: ${s.success} · tx ${s.transaction ? txLink(s.transaction) : "-"} · payer ${s.payer ?? "-"}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
