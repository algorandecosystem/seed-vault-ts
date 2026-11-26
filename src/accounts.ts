import {
  type Account,
  type AccountStoreExtension,
  type AccountStoreOptions,
  type AccountStoreState,
  addAccount,
  removeAccount,
} from "@algorandfoundation/accounts-store";
import type { Key, KeyStoreExtension, KeyStoreOptions, KeyStoreState } from "@algorandfoundation/keystore-core";
import type { LogStoreApi, LogStoreExtension } from "@algorandfoundation/log-store";
import type { Extension, ExtensionOptions } from "@algorandfoundation/wallet-provider";
import type { Store } from "@tanstack/store";

import { isSeedVaultKey } from "./store.ts";
import type { SeedVaultContext } from "./types.ts";

/**
 * Represents an account whose signing key is held by a Seed Vault.
 */
export interface SeedVaultAccount extends Account {
  type: "seed-vault-account";
  /**
   * Account metadata. Includes the id of the vault key the account signs with.
   */
  metadata?: {
    keyId: string;
    [key: string]: unknown;
  };
  /**
   * Asks the vault to sign a transaction or a set of transactions under one
   * approval.
   *
   * @param txns - The transactions to sign.
   * @returns What the vault produced for each transaction, in order.
   */
  sign: (txns: Uint8Array[]) => Promise<Uint8Array[]>;
}

/**
 * Resolves the address of the account a vault key controls, or `undefined`
 * when the key has no account.
 */
export type SeedVaultAddressResolver = (
  key: Key,
) => string | undefined | Promise<string | undefined>;

/**
 * Options for the AccountsSeedVault extension.
 */
export interface AccountsSeedVaultExtensionOptions
  extends ExtensionOptions, AccountStoreOptions<SeedVaultAccount>, KeyStoreOptions {
  accounts: AccountStoreOptions<SeedVaultAccount>["accounts"] & {
    seedVault: {
      /**
       * Resolves the address for each vault key. Keys it resolves to
       * `undefined` get no account.
       */
      address: SeedVaultAddressResolver;
      /**
       * Whether to automatically add accounts for the vault keys in the keystore.
       * Defaults to true.
       */
      autoPopulate?: boolean;
    };
  };
}

/**
 * Whether an account is backed by a key held in a Seed Vault.
 *
 * @example
 * ```typescript
 * const vaultAccounts = provider.accounts.filter(isSeedVaultAccount);
 * ```
 */
export function isSeedVaultAccount(account: Account): account is SeedVaultAccount {
  return account.type === "seed-vault-account";
}

/**
 * Extension that bridges the account store and the Seed Vault keystore.
 *
 * The keystore only knows pure keys. This extension builds accounts on top of
 * them: for every vault key in the keystore it resolves an address through
 * `options.accounts.seedVault.address` and adds an account whose `sign` asks
 * the vault, through the keystore, to sign transactions.
 *
 * @example
 * ```typescript
 * const WalletProvider = Provider.withExtensions([
 *   WithSeedVaultKeyStore,
 *   WithAccountStore,
 *   WithAccountsSeedVault,
 * ]);
 * const provider = new WalletProvider(config, {
 *   keystore: { store: keyStore, hooks: keyStoreHooks, binding },
 *   accounts: {
 *     store: accountStore,
 *     hooks: accountHooks,
 *     seedVault: { address: (key) => binding.address(key.id) },
 *   },
 * });
 * ```
 */
export const WithAccountsSeedVault: Extension<Record<never, never>> = (
  provider: KeyStoreExtension & AccountStoreExtension<SeedVaultAccount> & LogStoreExtension,
  options: AccountsSeedVaultExtensionOptions,
) => {
  // Ensure dependencies are present
  if (!provider.account) {
    throw new Error(
      "AccountsSeedVault extension requires WithAccountStore extension to be present on the provider.",
    );
  }
  if (!provider.key) {
    throw new Error(
      "AccountsSeedVault extension requires WithSeedVaultKeyStore extension to be present on the provider.",
    );
  }

  const log: LogStoreApi | undefined = provider.log;

  const keyStore: Store<KeyStoreState> = options.keystore.store;
  const accountStore: Store<AccountStoreState<SeedVaultAccount>> = options.accounts.store;
  const resolveAddress = options.accounts.seedVault?.address;
  const autoPopulate = options.accounts.seedVault?.autoPopulate ?? true;
  if (typeof resolveAddress !== "function") {
    throw new Error("AccountsSeedVault extension requires options.accounts.seedVault.address.");
  }

  const keys: Key[] = [];

  /**
   * Creates an account object for a given key ID and address.
   */
  const createKeyAccount = (keyId: string, address: string): SeedVaultAccount => ({
    address,
    type: "seed-vault-account",
    assets: [],
    metadata: { keyId },
    balance: BigInt(0),
    sign: async (txns: Uint8Array[]) => {
      // Read the keystore at call time and tell the vault these are transactions
      const keystore = provider.key.store;
      const ctx: SeedVaultContext = { intent: "transaction" };
      if (keystore.batchSign) {
        return keystore.batchSign(
          txns.map(() => keyId),
          txns,
          ctx,
        );
      }
      const signedTxns: Uint8Array[] = [];
      for (const txn of txns) {
        const signed = await keystore.sign(keyId, txn, undefined, ctx);
        signedTxns.push(signed);
      }
      return signedTxns;
    },
  });

  // Initial population if enabled
  if (autoPopulate) {
    let isProcessing = false;
    let nextKeys: Key[] | null = null;

    const processUpdates = async (allKeys: Key[]) => {
      // Only the keys the vault keystore owns produce vault accounts
      const newKeys = allKeys.filter(isSeedVaultKey);
      if (isProcessing) {
        nextKeys = newKeys;
        return;
      }
      isProcessing = true;
      try {
        nextKeys = null;

        // Find added keys
        const addedKeys = newKeys.filter(
          (newKey) => !keys.some((existingKey) => existingKey.id === newKey.id),
        );

        // Find removed keys
        const removedKeys = keys.filter(
          (existingKey) => !newKeys.some((newKey) => newKey.id === existingKey.id),
        );

        if (addedKeys.length === 0 && removedKeys.length === 0) {
          return;
        }

        // Update the local cache of keys BEFORE processing to ensure consistency
        keys.length = 0;
        newKeys.forEach((key) => keys.push(key));

        // Remove accounts for removed keys
        for (const key of removedKeys) {
          const account = accountStore.state.accounts.find(
            (item) => isSeedVaultAccount(item) && item.metadata?.keyId === key.id,
          );
          if (account) {
            log?.info(`Removing account for key ${key.id}-${key.type}...`);
            removeAccount<SeedVaultAccount>({ store: accountStore, address: account.address });
          }
        }

        // Process only the newly added keys
        for (const key of addedKeys) {
          let address: string | undefined;
          try {
            address = await resolveAddress(key);
          } catch (error) {
            log?.error(`Failed to resolve an address for key ${key.id}-${key.type}`, { error });
            // Forget the key so the next keystore update retries it
            keys.splice(keys.indexOf(key), 1);
            continue;
          }

          // Skip keys without an account, and accounts that already exist
          if (address && !accountStore.state.accounts.some((account) => account.address === address)) {
            log?.info(`Adding account for key ${key.id}-${key.type}...`);
            addAccount<SeedVaultAccount>({
              store: accountStore,
              account: createKeyAccount(key.id, address),
            });
          }
        }
      } finally {
        isProcessing = false;
        if (nextKeys) {
          const keysToProcess = nextKeys;
          nextKeys = null;
          void processUpdates(keysToProcess);
        }
      }
    };

    void processUpdates(keyStore.state.keys);

    keyStore.subscribe((state) => {
      if (state.status !== "ready" && state.status !== "idle") {
        return;
      }
      void processUpdates(state.keys);
    });
  }

  return {};
};