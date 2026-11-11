import { NextRequest, NextResponse } from "next/server";
import { withX402, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, ROBINHOOD, sellerEnv, usdgExactScheme } from "../../../lib/usdg";

// Runs only after the payment is verified. withX402 settles it after this answers (not on an error).
async function weather(_req: NextRequest) {
  return NextResponse.json({ city: "Anywhere", forecast: "sunny", tempC: 24 });
}

// Built on the first request, so `next build` works without PAY_TO set.
let paid: ((req: NextRequest) => Promise<NextResponse<unknown>>) | null = null;

function build() {
  const { payTo, extra } = sellerEnv();
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(ROBINHOOD, usdgExactScheme());
  return withX402(
    weather,
    {
      accepts: { scheme: "exact", price: "$0.01", network: ROBINHOOD, payTo, ...(extra ? { extra } : {}) },
      description: "Today's weather, for 0.01 USDG",
      mimeType: "application/json",
    },
    server,
  );
}

export async function GET(req: NextRequest) {
  paid ??= build();
  return paid(req);
}
