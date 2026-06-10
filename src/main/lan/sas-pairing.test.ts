import { describe, expect, it } from "vitest"
import { SasPairingManager } from "./sas-pairing"

const alice = {
  deviceId: "alice",
  name: "Alice",
  certificatePem: "alice-cert",
  certificateFingerprint: "alice-fingerprint",
}
const bob = {
  deviceId: "bob",
  name: "Bob",
  certificatePem: "bob-cert",
  certificateFingerprint: "bob-fingerprint",
}

describe("sasPairingManager", () => {
  it("derives the same SAS on both devices after commit and reveal", () => {
    const initiator = new SasPairingManager(alice, () => 10)
    const responder = new SasPairingManager(bob, () => 10)
    const draft = initiator.createOutgoingDraft()
    const challenge = responder.acceptIncomingCommitment(draft.commitment)
    const outgoing = draft.complete(challenge)
    const incoming = responder.acceptIncomingReveal(challenge.id, outgoing.reveal)

    expect(outgoing.pairing.sas).toMatch(/^\d{6}$/)
    expect(incoming.sas).toBe(outgoing.pairing.sas)
    expect(() => initiator.prepareOutgoingConfirmation(challenge.id, "000000")).toThrow(
      "Security code is incorrect."
    )
    expect(initiator.prepareOutgoingConfirmation(challenge.id, outgoing.pairing.sas)).toMatchObject(
      { deviceId: "bob" }
    )
    expect(responder.prepareIncomingConfirmation(challenge.id)).toMatchObject({
      deviceId: "alice",
    })
    initiator.markConfirmed(challenge.id, "outgoing")
    responder.markConfirmed(challenge.id, "incoming")
  })

  it("rejects a reveal that does not match the commitment", () => {
    const initiator = new SasPairingManager(alice)
    const responder = new SasPairingManager(bob)
    const draft = initiator.createOutgoingDraft()
    const challenge = responder.acceptIncomingCommitment(draft.commitment)
    const outgoing = draft.complete(challenge)

    expect(() =>
      responder.acceptIncomingReveal(challenge.id, {
        ...outgoing.reveal,
        initiatorNonce: "tampered",
      })
    ).toThrow("Pairing commitment does not match reveal.")
  })

  it("carries the initiator endpoint port in the pairing commitment", () => {
    const initiator = new SasPairingManager(alice)

    expect(initiator.createOutgoingDraft({ endpointPort: 49200 }).commitment).toMatchObject({
      endpointPort: 49200,
      identity: alice,
    })
  })
})
