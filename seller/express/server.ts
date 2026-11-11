import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, ROBINHOOD, sellerEnv, usdgExactScheme } from "./usdg.js";

const { payTo, port, extra } = sellerEnv();

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator).register(ROBINHOOD, usdgExactScheme());

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: { scheme: "exact", price: "$0.01", network: ROBINHOOD, payTo, ...(extra ? { extra } : {}) },
        description: "Today's weather, for 0.01 USDG",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

// Runs only after the payment is verified. The middleware settles it after this answers.
app.get("/weather", (_req, res) => {
  res.json({ city: "Anywhere", forecast: "sunny", tempC: 24 });
});

// Free route, no payment.
app.get("/", (_req, res) => {
  res.json({ paid: "GET /weather (0.01 USDG on Robinhood Chain)", facilitator: FACILITATOR_URL });
});

app.listen(port, () => {
  console.log(`seller on http://localhost:${port} · GET /weather costs 0.01 USDG · pays ${payTo}`);
});
