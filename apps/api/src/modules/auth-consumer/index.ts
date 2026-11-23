// Module provider export for the consumer auth provider (phase 19-3).
// Registered from medusa-config.ts as:
//
//   {
//     resolve: "./src/modules/auth-consumer",
//     id: "consumer",
//     options: { bridgeSecret: process.env.MERCUR_BRIDGE_SECRET },
//   }
//
// The `id` ("consumer") is the route segment: POST /auth/customer/consumer.
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import ConsumerAuthService from "./consumer-auth"

export default ModuleProvider(Modules.AUTH, {
  services: [ConsumerAuthService],
})
