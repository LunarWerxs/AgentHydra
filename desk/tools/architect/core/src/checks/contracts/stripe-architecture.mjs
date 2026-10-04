import {
  STRIPE_ARCHITECTURE_DEFAULTS,
  runStripeArchitectureAudit,
} from "@saydeploy/architect/engines/contracts/stripe-architecture-engine";

export const audit = {
  id: "stripe-architecture",
  title: "Stripe Architecture",
  category: "backend",
  defaultConfig: STRIPE_ARCHITECTURE_DEFAULTS,
  run: runStripeArchitectureAudit,
};
