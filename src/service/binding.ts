import { SeedVaultUnavailableError } from "../errors.ts";
import type {
  SeedVaultBatchSignRequest,
  SeedVaultBinding,
  SeedVaultIntent,
  SeedVaultKey,
  SeedVaultSignRequest,
} from "../types.ts";
import NativeSeedVaultService, { type SeedVaultServiceModule } from "./NativeSeedVaultService.ts";

const MAX_BATCH_SIZE = 16;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface NativeAccount {
  index: number;
  address: string;
  publicKey: string;
  isAutosign: boolean;
  requiresApproval?: boolean;
}

interface NativeSeed {
  id: string | number;
  name: string;
  accounts: NativeAccount[];
}

interface SeedVaultServiceBinding extends Omit<SeedVaultBinding, "signBatch"> {
  signBatch(request: SeedVaultBatchSignRequest): Promise<Uint8Array[] | null | undefined>;
  isAvailable(): Promise<boolean>;
  authorize(): Promise<boolean>;
  address(id: string): string | undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined ? "=" : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : BASE64_ALPHABET[third & 63];
  }
  return encoded;
}

function decodeBase64(encoded: string): Uint8Array {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TypeError("Seed Vault returned invalid base64 data");
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((encoded.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(encoded[index] as string);
    const second = BASE64_ALPHABET.indexOf(encoded[index + 1] as string);
    const third = encoded[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(encoded[index + 2] as string);
    const fourth = encoded[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(encoded[index + 3] as string);
    bytes[outputIndex++] = (first << 2) | (second >> 4);
    if (outputIndex < bytes.length) bytes[outputIndex++] = ((second & 15) << 4) | (third >> 2);
    if (outputIndex < bytes.length) bytes[outputIndex++] = ((third & 3) << 6) | fourth;
  }
  return bytes;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isUnavailableRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "E_SEED_VAULT_UNAVAILABLE"
  );
}

async function invokeNative<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUnavailableRejection(error)) {
      throw new SeedVaultUnavailableError("Seed Vault service is not available", toError(error));
    }
    throw error;
  }
}

function isSecurityRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "E_SEED_VAULT_SECURITY") ||
      ("name" in error && error.name === "SecurityException"))
  );
}

function decodeSeeds(json: string): NativeSeed[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new TypeError("Seed Vault returned an invalid seed list");
  return value as NativeSeed[];
}

/**
 * Creates a {@link SeedVaultBinding} for the Android Seed Vault service.
 * Key identifiers use `<seedId>/<accountIndex>`; service addresses remain
 * private to this binding and are exposed only through `address()`.
 */
export function createSeedVaultServiceBinding(options: {
  nativeModule?: SeedVaultServiceModule | null;
} = {}): SeedVaultServiceBinding {
  const nativeModule = options.nativeModule === undefined ? NativeSeedVaultService : options.nativeModule;
  const addresses = new Map<string, string>();
  const accounts = new Map<string, NativeAccount>();

  const requireModule = (): SeedVaultServiceModule => {
    if (!nativeModule) throw new SeedVaultUnavailableError("native service module is not installed");
    return nativeModule;
  };

  const requireAccount = (id: string): NativeAccount => {
    const account = accounts.get(id);
    if (!account) throw new SeedVaultUnavailableError(`key is not in the authorized seed list: ${id}`);
    return account;
  };

  const confirm = async (
    module: SeedVaultServiceModule,
    account: NativeAccount,
    data: Uint8Array,
    intent: SeedVaultIntent,
  ): Promise<boolean> => {
    const encoded = encodeBase64(data);
    return intent === "transaction"
      ? invokeNative(() => module.confirmSignTransaction(account.address, encoded))
      : invokeNative(() => module.confirmSignBytes(account.address, encoded));
  };

  const signOne = async (request: SeedVaultSignRequest): Promise<Uint8Array | null> => {
    const module = requireModule();
    const account = requireAccount(request.id);
    const encoded = encodeBase64(request.data);
    const sign = (): Promise<string | null> =>
      request.intent === "transaction"
        ? invokeNative(() => module.signTransaction(account.address, encoded))
        : invokeNative(() => module.signBytes(account.address, encoded));

    if (account.requiresApproval !== false) {
      if (!(await confirm(module, account, request.data, request.intent))) return null;
      const signed = await sign();
      return signed === null ? null : decodeBase64(signed);
    }

    try {
      const signed = await sign();
      return signed === null ? null : decodeBase64(signed);
    } catch (error) {
      if (!isSecurityRejection(error)) throw error;
      if (!(await confirm(module, account, request.data, request.intent))) return null;
      const signed = await sign();
      return signed === null ? null : decodeBase64(signed);
    }
  };

  const confirmTransactions = async (
    module: SeedVaultServiceModule,
    account: NativeAccount,
    transactions: Uint8Array[],
  ): Promise<boolean> => {
    const encoded = transactions.map(encodeBase64);
    const batchSupported =
      module.confirmSignTransactions &&
      module.isBatchSupported &&
      (await invokeNative(() => module.isBatchSupported!()));
    if (batchSupported) {
      return invokeNative(() => module.confirmSignTransactions!(account.address, JSON.stringify(encoded)));
    }

    for (const transaction of transactions) {
      if (
        !(await invokeNative(() =>
          module.confirmSignTransaction(account.address, encodeBase64(transaction)),
        ))
      ) {
        return false;
      }
    }
    return true;
  };

  const signTransactions = async (
    module: SeedVaultServiceModule,
    account: NativeAccount,
    transactions: Uint8Array[],
  ): Promise<Uint8Array[] | null> => {
    const signChunk = async (): Promise<Uint8Array[] | null> => {
      const signed: Uint8Array[] = [];
      for (const transaction of transactions) {
        const result = await invokeNative(() =>
          module.signTransaction(account.address, encodeBase64(transaction)),
        );
        if (result === null) return null;
        signed.push(decodeBase64(result));
      }
      return signed;
    };

    if (account.requiresApproval !== false) {
      if (!(await confirmTransactions(module, account, transactions))) return null;
      return signChunk();
    }

    try {
      return await signChunk();
    } catch (error) {
      if (!isSecurityRejection(error)) throw error;
      if (!(await confirmTransactions(module, account, transactions))) return null;
      return signChunk();
    }
  };

  const isAvailable = async (): Promise<boolean> => {
    if (!nativeModule) return false;
    try {
      return await nativeModule.isAvailable();
    } catch {
      return false;
    }
  };

  return {
    maxBatchSize: MAX_BATCH_SIZE,

    isAvailable,

    async authorize(): Promise<boolean> {
      const module = requireModule();
      if (!(await isAvailable())) {
        throw new SeedVaultUnavailableError("Seed Vault service is not available");
      }
      return invokeNative(() => module.authorize());
    },

    address(id: string): string | undefined {
      return addresses.get(id);
    },

    async keys(): Promise<SeedVaultKey[]> {
      const module = requireModule();
      if (!(await this.isAvailable())) {
        throw new SeedVaultUnavailableError("Seed Vault service is not available");
      }

      try {
        const seeds = decodeSeeds(await invokeNative(() => module.getAuthorizedSeeds()));
        addresses.clear();
        accounts.clear();
        return seeds.flatMap((seed) =>
          seed.accounts.map((account) => {
            const id = `${seed.id}/${account.index}`;
            addresses.set(id, account.address);
            accounts.set(id, account);
            return {
              id,
              algorithm: "Falcon-1024",
              publicKey: decodeBase64(account.publicKey),
              name: seed.name,
              metadata: {
                seedId: String(seed.id),
                accountIndex: account.index,
                isAutosign: account.isAutosign,
                requiresApproval: account.requiresApproval,
              },
            };
          }),
        );
      } catch (error) {
        if (error instanceof SeedVaultUnavailableError) throw error;
        throw new SeedVaultUnavailableError("could not list authorized seeds", toError(error));
      }
    },

    sign: signOne,

    async signBatch(request: SeedVaultBatchSignRequest): Promise<Uint8Array[] | null> {
      const account = requireAccount(request.id);
      if (request.intent !== "transaction") {
        const signatures: Uint8Array[] = [];
        for (const data of request.data) {
          const signature = await signOne({ id: request.id, data, intent: request.intent });
          if (signature === null) return null;
          signatures.push(signature);
        }
        return signatures;
      }

      const module = requireModule();
      const signatures: Uint8Array[] = [];
      for (let index = 0; index < request.data.length; index += MAX_BATCH_SIZE) {
        const signed = await signTransactions(
          module,
          account,
          request.data.slice(index, index + MAX_BATCH_SIZE),
        );
        if (!signed) return null;
        signatures.push(...signed);
      }
      return signatures;
    },
  };
}

export type { SeedVaultServiceBinding };