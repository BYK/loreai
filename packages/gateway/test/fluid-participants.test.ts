import { db } from "@loreai/core";
import { describe, expect, it } from "vitest";
import {
  createFluidSpikeSecret,
  signFluidSpikeToken,
  verifyFluidSpikeToken,
} from "../src/fluid/auth";
import {
  grantFluidShare,
  hasFluidShare,
  initializeFluidTables,
  revokeFluidShare,
} from "../src/fluid/sqlite";

describe("Fluid participant controls", () => {
  it("attests the participant in a document-bound token", () => {
    const secret = createFluidSpikeSecret();
    const token = signFluidSpikeToken(
      {
        documentId: "D1",
        scopes: ["doc:read", "doc:write"],
        tenantId: "fluid",
        user: { id: "agent", name: "Agent" },
      },
      secret,
    );

    expect(
      verifyFluidSpikeToken(token, secret, {
        tenantId: "fluid",
        documentId: "D1",
      }).user.id,
    ).toBe("agent");
    expect(() =>
      verifyFluidSpikeToken(token, secret, {
        tenantId: "fluid",
        documentId: "D2",
      }),
    ).toThrow("Invalid Fluid token claims");
  });

  it("denies an unshared document and records share revocation", () => {
    initializeFluidTables();
    db().exec("DELETE FROM fluid_spike_shares");
    grantFluidShare("D1", "agent");

    expect(hasFluidShare("D1", "agent")).toBe(true);
    expect(hasFluidShare("D2", "agent")).toBe(false);

    revokeFluidShare("D1", "agent");
    expect(hasFluidShare("D1", "agent")).toBe(false);
  });
});
