// The Neson consumer auth provider (phase 19-3, the buyer identity
// bridge). It authenticates the platform's consumer accounts — the
// bridge's phone-verified u_ identities (18-6) — into the marketplace
// as Medusa customers.
//
// Trust model: the marketplace holds no phone verification and no
// consumer directory of its own. The platform bridge is the sole
// credential issuer: it signs a short-lived credential (HMAC-SHA256,
// the per-deploy shared secret) for identities it knows, and
// `POST /auth/customer/consumer` is the only entry for a consumer.
// There is no email/password, no self-registration, no callback:
// everything that is not a well-formed signed credential is a 401.
//
// On a valid credential the provider resolves the consumer's customer
// (create-or-return, keyed on the deterministic alias email
// <phone digits>@consumer.neson.local) and their auth identity, and
// links the two through app_metadata.customer_id — the claim the HTTP
// layer bakes into the customer JWT.
import { createHmac, timingSafeEqual } from "crypto"
import {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityDTO,
  AuthIdentityProviderService,
  ICustomerModuleService,
  Logger,
} from "@medusajs/framework/types"
import {
  AbstractAuthModuleProvider,
  MedusaError,
  Modules,
  isPresent,
  isString,
} from "@medusajs/framework/utils"

type Options = {
  /**
   * The shared HMAC secret the platform bridge signs credentials with
   * (env MERCUR_BRIDGE_SECRET). Required: without it the provider
   * cannot verify anything and must not boot.
   */
  bridgeSecret: string
}

type Credential = {
  v: number
  sub: string
  phone: string
  email: string
  display_name: string
  iat: number
  exp: number
  nonce: string
}

// v1 is the current credential schema; the bridge and this provider
// move it together (a version bump is a coordinated change, never a
// silent one).
const CREDENTIAL_VERSION = 1

// The platform's consumer alias domain (18-6): the deterministic email
// a consumer's marketplace customer is keyed on. The mini-store
// checkout sends the same alias, so a consumer's marketplace and
// mini-store identities stay aligned by construction.
const ALIAS_DOMAIN = "consumer.neson.local"

// Tolerated clock skew for the iat/exp window (the bridge and the
// marketplace run on different hosts).
const SKEW_SECONDS = 30

// The fabric identity shape the bridge mints for consumers:
// u_ + 26 unpadded-base32 chars (ids.Person, 16 random bytes).
const FABRIC_ID = /^u_[A-Z2-7]{26}$/

// The storefront's E.164-ish shape (the bridge's phoneRe, mirrored).
const PHONE = /^\+?[1-9]\d{6,14}$/

const aliasEmail = (phone: string) =>
  `${phone.replace(/\D/g, "")}@${ALIAS_DOMAIN}`

export class ConsumerAuthService extends AbstractAuthModuleProvider {
  static identifier = "consumer"
  static DISPLAY_NAME = "Neson consumer (bridge-signed)"

  protected options_: Options
  protected logger_: Logger
  // The AUTH module's local container cradle. The abstract class
  // declares a `container_` field but never assigns it, so the
  // provider holds its own reference to the cradle it was
  // constructed with: the declared dependencies (the CUSTOMER
  // module) and the AUTH module's internal services
  // (authIdentityService) both resolve from it.
  protected cradle_: any

  constructor(cradle: any, options: Options) {
    // @ts-ignore
    super(...arguments)
    this.cradle_ = cradle
    this.logger_ = cradle?.logger
    this.options_ = options
  }

  static validateOptions(options: Record<string, unknown>) {
    if (!isString(options?.bridgeSecret) || !options.bridgeSecret.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The consumer auth provider requires options.bridgeSecret"
      )
    }
  }

  async authenticate(
    data: AuthenticationInput,
    authIdentityService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    const credential = (
      data.body as { credential?: unknown } | undefined
    )?.credential
    if (!isString(credential)) {
      return { success: false, error: "credential is required" }
    }
    const claim = this.verify_(credential)
    if (!claim) {
      // One error for every invalid credential: a distinct message
      // would tell an attacker which part of the check failed.
      return { success: false, error: "Invalid consumer credential" }
    }
    try {
      const authIdentity = await this.resolveIdentity_(
        claim,
        authIdentityService
      )
      return { success: true, authIdentity }
    } catch (error) {
      // The stack goes to the log only — the client gets the flat
      // error (no internals leak over the wire).
      this.logger_.error(
        `consumer auth: ${error instanceof Error ? error.stack : error}`
      )
      return { success: false, error: "Consumer authentication failed" }
    }
  }

  // No self-service registration: a consumer account is created by the
  // platform's phone rail, and the bridge's credential is the only way
  // in. (The route returns 401 for this.)
  async register(): Promise<AuthenticationResponse> {
    return {
      success: false,
      error: "Consumer registration is closed; use the platform",
    }
  }

  // The consumer carries no password, so there is nothing to update.
  async update(): Promise<AuthenticationResponse> {
    return { success: false, error: "Consumer credentials cannot be updated" }
  }

  // Splits "b64url(payload).b64url(sig)" and checks, in order: the
  // HMAC, the credential version, the claim invariants (sub is a
  // fabric u_ id, phone is E.164-ish, the email IS the alias derived
  // from the phone, display name is bounded) and the iat/exp window.
  // The signature is the trust anchor; the invariants guard against a
  // compromised bridge minting garbage customers.
  private verify_(credential: string): Credential | null {
    const parts = credential.split(".")
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return null
    }
    const [payload, sig] = parts
    const sigBytes = Buffer.from(sig, "base64url")
    if (sigBytes.length !== 32) {
      return null
    }
    const mac = createHmac("sha256", this.options_.bridgeSecret)
      .update(payload)
      .digest()
    if (!timingSafeEqual(mac, sigBytes)) {
      return null
    }
    const payloadBytes = Buffer.from(payload, "base64url")
    if (!payloadBytes.length) {
      return null
    }
    let claim: Credential
    try {
      claim = JSON.parse(payloadBytes.toString("utf8")) as Credential
    } catch {
      return null
    }
    if (claim.v !== CREDENTIAL_VERSION) return null
    if (!isString(claim.sub) || !FABRIC_ID.test(claim.sub)) return null
    if (!isString(claim.phone) || !PHONE.test(claim.phone)) return null
    if (!isString(claim.email) || claim.email !== aliasEmail(claim.phone))
      return null
    if (
      !isString(claim.display_name) ||
      !claim.display_name.length ||
      claim.display_name.length > 100
    )
      return null
    if (
      !Number.isInteger(claim.iat) ||
      !Number.isInteger(claim.exp) ||
      !isString(claim.nonce) ||
      !isPresent(claim.nonce)
    )
      return null
    const now = Math.floor(Date.now() / 1000)
    if (now > claim.exp + SKEW_SECONDS || now < claim.iat - SKEW_SECONDS) {
      return null
    }
    return claim
  }

  // Resolves the consumer's customer and auth identity and links them.
  // The customer lives in the CUSTOMER module (a declared dependency of
  // the AUTH module, resolved from this provider's cradle); the actor
  // link (app_metadata.customer_id) is written through the auth module's
  // internal identity service (also on the cradle), because the
  // provider-facing identity service does not expose app_metadata.
  //
  // Both resolutions are create-or-return on a deterministic key (the
  // alias email), so a retried or raced exchange converges: a lost
  // create race on the auth identity fails this call and the next one
  // wins (the customer row is then reused, never duplicated by the
  // lookup-first shape).
  private async resolveIdentity_(
    claim: Credential,
    authIdentityService: AuthIdentityProviderService
  ): Promise<AuthIdentityDTO> {
    const customerModule = this.cradle_[Modules.CUSTOMER] as ICustomerModuleService
    const customers = await customerModule.listCustomers(
      { email: claim.email },
      { take: 1 }
    )
    let customer = customers[0]
    if (!customer) {
      const digits = claim.phone.replace(/\D/g, "")
      const [created] = await customerModule.createCustomers([
        {
          email: claim.email,
          first_name: "Customer",
          last_name: digits.slice(-4),
          metadata: {
            phone_e164: claim.phone,
            fabric_id: claim.sub,
          },
        },
      ])
      customer = created
    }

    let authIdentity: AuthIdentityDTO
    try {
      authIdentity = await authIdentityService.retrieve({
        entity_id: claim.email,
      })
    } catch (error) {
      if (error.type === MedusaError.Types.NOT_FOUND) {
        authIdentity = await authIdentityService.create({
          entity_id: claim.email,
          provider_metadata: {
            fabric_id: claim.sub,
            phone_e164: claim.phone,
          },
          user_metadata: { display_name: claim.display_name },
        })
      } else {
        throw error
      }
    }

    if (authIdentity.app_metadata?.customer_id !== customer.id) {
      const internal = this.cradle_.authIdentityService
      await internal.update({
        id: authIdentity.id,
        app_metadata: {
          ...(authIdentity.app_metadata ?? {}),
          customer_id: customer.id,
        },
      })
      authIdentity = {
        ...authIdentity,
        app_metadata: {
          ...(authIdentity.app_metadata ?? {}),
          customer_id: customer.id,
        },
      }
    }
    return authIdentity
  }
}

export default ConsumerAuthService
