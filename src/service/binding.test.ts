import { vi } from "vitest";

vi.mock("react-native", () => ({
  TurboModuleRegistry: {
    get: () => null,
  },
}));

import { Store } from "@tanstack/store";
import { describe, expect, it } from "vitest";

import { createSeedVaultKeyStore } from "../engine.ts";
import { SeedVaultRejectedError, SeedVaultUnavailableError } from "../errors.ts";
import { createSeedVaultServiceBinding } from "./binding.ts";
import type { SeedVaultServiceModule } from "./NativeSeedVaultService.ts";

const seed = {
  id: "42",
  name: "Primary",
  accounts: [
    {
      index: 0,
      address: "ADDR-HUMAN",
      publicKey: "AQIDBA==",
      isAutosign: false,
      requiresApproval: true,
    },
    {
      index: 1,
      address: "ADDR-AUTO",
      publicKey: "BQYHCA==",
      isAutosign: true,
      requiresApproval: false,
    },
  ],
};

function createNativeModule(overrides: Partial<SeedVaultServiceModule> = {}): SeedVaultServiceModule {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    isBatchSupported: vi.fn().mockResolvedValue(true),
    getAuthorizedSeeds: vi.fn().mockResolvedValue(JSON.stringify([seed])),
    authorize: vi.fn().mockResolvedValue(true),
    confirmSignBytes: vi.fn().mockResolvedValue(true),
    confirmSignTransaction: vi.fn().mockResolvedValue(true),
    confirmSignTransactions: vi.fn().mockResolvedValue(true),
    signBytes: vi.fn().mockResolvedValue("CQgH"),
    signTransaction: vi.fn().mockResolvedValue("CgsM"),
    ...overrides,
  };
}

describe("Seed Vault service binding", () => {
  it("maps authorized accounts to stable seed/index IDs and keeps addresses behind the binding", async () => {
    const binding = createSeedVaultServiceBinding({ nativeModule: createNativeModule() });

    const keys = await binding.keys();

    expect(keys.map(({ id }) => id)).toEqual(["42/0", "42/1"]);
    expect(keys[0]).toMatchObject({
      algorithm: "Falcon-1024",
      name: "Primary",
      metadata: { isAutosign: false, requiresApproval: true },
    });
    expect(Array.from(keys[0]!.publicKey)).toEqual([1, 2, 3, 4]);
    expect(binding.address("42/0")).toBe("ADDR-HUMAN");
    expect(binding.address("unknown")).toBeUndefined();
  });

  it("confirms human-sign requests before signing bytes", async () => {
    const nativeModule = createNativeModule();
    const binding = createSeedVaultServiceBinding({ nativeModule });
    await binding.keys();

    const signature = await binding.sign({ id: "42/0", data: Uint8Array.of(1, 2, 3, 4), intent: "bytes" });

    expect(nativeModule.confirmSignBytes).toHaveBeenCalledWith("ADDR-HUMAN", "AQIDBA==");
    expect(vi.mocked(nativeModule.confirmSignBytes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(nativeModule.signBytes).mock.invocationCallOrder[0] as number,
    );
    expect(Array.from(signature!)).toEqual([9, 8, 7]);
  });

  it("returns null on declined approval and the keystore turns that into SeedVaultRejectedError", async () => {
    const nativeModule = createNativeModule({ confirmSignBytes: vi.fn().mockResolvedValue(false) });
    const binding = createSeedVaultServiceBinding({ nativeModule });
    const store = new Store({ keys: [], status: "idle" });
    const keystore = createSeedVaultKeyStore({ binding, store, subtle: globalThis.crypto.subtle, shims: [] });
    await keystore.ready;

    await expect(keystore.sign("42/0", Uint8Array.of(1))).rejects.toBeInstanceOf(SeedVaultRejectedError);
    expect(nativeModule.signBytes).not.toHaveBeenCalled();
  });

  it("autosigns without prompting, then retries once after a security rejection", async () => {
    const nativeModule = createNativeModule({
      signBytes: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("approval required"), { code: "E_SEED_VAULT_SECURITY" }))
        .mockResolvedValue("CQgH"),
    });
    const binding = createSeedVaultServiceBinding({ nativeModule });
    await binding.keys();

    const signature = await binding.sign({ id: "42/1", data: Uint8Array.of(1), intent: "bytes" });

    expect(nativeModule.signBytes).toHaveBeenCalledTimes(2);
    expect(nativeModule.confirmSignBytes).toHaveBeenCalledTimes(1);
    expect(Array.from(signature!)).toEqual([9, 8, 7]);
  });

  it("uses transaction approval and returns the signed transaction bytes", async () => {
    const nativeModule = createNativeModule();
    const binding = createSeedVaultServiceBinding({ nativeModule });
    await binding.keys();

    const signed = await binding.sign({ id: "42/0", data: Uint8Array.of(1, 2, 3), intent: "transaction" });

    expect(nativeModule.confirmSignTransaction).toHaveBeenCalledWith("ADDR-HUMAN", "AQID");
    expect(nativeModule.signTransaction).toHaveBeenCalledWith("ADDR-HUMAN", "AQID");
    expect(Array.from(signed!)).toEqual([10, 11, 12]);
  });

  it("chunks transaction confirmation at 16 and falls back to one confirmation per transaction", async () => {
    const nativeModule = createNativeModule();
    const binding = createSeedVaultServiceBinding({ nativeModule });
    await binding.keys();
    const data = Array.from({ length: 17 }, (_, index) => Uint8Array.of(index));

    const signed = await binding.signBatch({ id: "42/0", data, intent: "transaction" });

    expect(binding.maxBatchSize).toBe(16);
    expect(nativeModule.confirmSignTransactions).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(nativeModule.confirmSignTransactions!)
        .mock.calls.map(([, transactions]) => JSON.parse(transactions).length),
    ).toEqual([16, 1]);
    expect(signed).toHaveLength(17);

    const fallbackModule = createNativeModule({ isBatchSupported: vi.fn().mockResolvedValue(false) });
    const fallbackBinding = createSeedVaultServiceBinding({ nativeModule: fallbackModule });
    await fallbackBinding.keys();
    await fallbackBinding.signBatch({ id: "42/0", data: data.slice(0, 2), intent: "transaction" });
    expect(fallbackModule.confirmSignTransactions).not.toHaveBeenCalled();
    expect(fallbackModule.confirmSignTransaction).toHaveBeenCalledTimes(2);

    const oldNativeModule = createNativeModule();
    oldNativeModule.confirmSignTransactions = undefined;
    const oldBinding = createSeedVaultServiceBinding({ nativeModule: oldNativeModule });
    await oldBinding.keys();
    await oldBinding.signBatch({ id: "42/0", data: data.slice(0, 2), intent: "transaction" });
    expect(oldNativeModule.confirmSignTransaction).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable native module and exposes availability and authorization helpers", async () => {
    const unavailable = createSeedVaultServiceBinding({ nativeModule: null });
    expect(await unavailable.isAvailable()).toBe(false);
    await expect(unavailable.keys()).rejects.toBeInstanceOf(SeedVaultUnavailableError);
    await expect(unavailable.authorize()).rejects.toBeInstanceOf(SeedVaultUnavailableError);

    const nativeModule = createNativeModule();
    const binding = createSeedVaultServiceBinding({ nativeModule });
    expect(await binding.isAvailable()).toBe(true);
    expect(await binding.authorize()).toBe(true);
    expect(nativeModule.authorize).toHaveBeenCalledOnce();
  });

  it("maps a disconnected native service to SeedVaultUnavailableError during signing", async () => {
    const nativeModule = createNativeModule({
      signBytes: vi.fn().mockRejectedValue(Object.assign(new Error("service disconnected"), {
        code: "E_SEED_VAULT_UNAVAILABLE",
      })),
    });
    const binding = createSeedVaultServiceBinding({ nativeModule });
    await binding.keys();

    await expect(
      binding.sign({ id: "42/1", data: Uint8Array.of(1), intent: "bytes" }),
    ).rejects.toBeInstanceOf(SeedVaultUnavailableError);
  });
});