// VoxTheBoxTheCallingPilot — platform carrier (bundled model).
//
// Bundled calling: customers bring NO telephony account. Vox provides
// calling through ONE platform carrier account, cost included in the
// subscription. The old per-customer telephony-connect layer is
// superseded and deliberately NOT present in this build — there are no
// per-customer telephony credentials, no per-customer connect endpoints,
// and no per-customer webhook verification anywhere here.
//
// Carrier status is intentionally UNCONFIGURED in this build: the
// carrier account is picked but deferred, so no carrier account, keys,
// or numbers exist here. All call behavior in this build is demo/sample
// data only (demo-safe). When the operator is ready, they create the
// platform carrier account themselves and set PLATFORM_CARRIER_*
// environment variables; until then every call endpoint answers with
// carrier_unconfigured and nothing is placed.

function carrierStatus() {
  const configured = Boolean(process.env.PLATFORM_CARRIER_API_KEY && process.env.PLATFORM_CARRIER_ACCOUNT_ID);
  return {
    model: "bundled",
    configured,
    carrier: configured ? "platform" : "deferred",
    callingIncluded: true,
    demoOnly: !configured,
    message: configured
      ? "Platform carrier is configured."
      : "Calling is included in the subscription. The platform carrier connection is not set up yet, so live calls are not placed from this build — everything shown is sample data.",
  };
}

module.exports = { carrierStatus };
