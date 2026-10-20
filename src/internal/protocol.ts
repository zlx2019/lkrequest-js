import type { NativeBrokenQuicPolicy, NativeProtocolPolicy } from "../../native/index.cjs";
import type { AcquisitionPolicy, BrokenQuicPolicy, ProtocolPolicy } from "../types.js";
import { invalidConfig } from "./native-error.js";

/**
 * The native spelling of a protocol policy: a preset name becomes `{ preset }`, and a race
 * acquisition is spread into the acquisition name and its parameters.
 */
export function toNativeProtocolPolicy(policy: ProtocolPolicy): NativeProtocolPolicy {
  if (typeof policy === "string") return { preset: policy };
  const { preset, intent, acquisition, upgrade, fallback } = policy;
  return { preset, intent, ...toNativeAcquisition(acquisition), upgrade, fallback };
}

/** Spells an acquisition policy as a name, plus the parameters of a race. */
function toNativeAcquisition(
  acquisition: AcquisitionPolicy | undefined,
): Pick<NativeProtocolPolicy, "acquisition" | "race"> {
  if (acquisition === undefined || typeof acquisition === "string") return { acquisition };
  if (typeof acquisition !== "object" || acquisition === null || !("race" in acquisition)) {
    throw invalidConfig(
      "protocolPolicy.acquisition must be a name or { race: { ... } }, for example { race: { tcpDelay: 100 } }",
    );
  }
  return { acquisition: "race", race: { ...acquisition.race } };
}

/** The native spelling of a QUIC failure policy: a preset name becomes `{ preset }`. */
export function toNativeBrokenQuicPolicy(policy: BrokenQuicPolicy): NativeBrokenQuicPolicy {
  return typeof policy === "string" ? { preset: policy } : { ...policy };
}
