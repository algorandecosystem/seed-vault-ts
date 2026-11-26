# @algorandecosystem/seed-vault

React Native `KeyStore` implementation backed by Algorand Seed Vault. It replaces the local `WithKeyStore` extension while preserving the Wallet Provider keystore surface; private key material remains in the Seed Vault service.

This is the first migration step, targeting the current Wallet Provider canary APIs. The follow-up section records the intended path to the shared keystore 1.0.0 design.

## Install

```sh
pnpm add @algorandecosystem/seed-vault
```

The host application must provide the package's peer dependencies, including the same single runtime instance of `@algorandfoundation/keystore-core` and `@algorandfoundation/wallet-provider` used by its other extensions. React Native autolinks the Android module; rebuild the Android app after installation. No iOS native module is provided.

## Replace `WithKeyStore`

Keep the provider's existing reactive keystore store, hooks, and non-keystore extensions. Replace `WithKeyStore` with `WithSeedVaultKeyStore`; do not install both keystore extensions on one provider. Authorize the app with Seed Vault before the provider loads its keys:

```typescript
import { Provider } from "@algorandfoundation/wallet-provider";
import {
  createSeedVaultServiceBinding,
  WithSeedVaultKeyStore,
} from "@algorandecosystem/seed-vault";

const binding = createSeedVaultServiceBinding();
if (!(await binding.isAvailable())) {
  throw new Error("Seed Vault service is not installed");
}
if (!(await binding.authorize())) {
  throw new Error("The user declined authorization");
}

const WalletProvider = Provider.withExtensions([
  ...existingNonKeystoreExtensions,
  WithSeedVaultKeyStore,
]);
const provider = new WalletProvider(
  { id: "pera", name: "Pera" },
  {
    ...existingOptions,
    keystore: {
      ...existingOptions.keystore,
      binding,
    },
  },
);

await provider.key.store.ready;
```

`existingOptions.keystore.store` and `existingOptions.keystore.hooks` remain the host's existing objects. The adapter exposes authorized keys as stable IDs of the form `<seedId>/<accountIndex>` and keeps the address-based Seed Vault API inside the binding. `binding.address(id)` is available to an accounts-layer integration that needs the corresponding service address.

## Accounts integration

The optional accounts bridge is available from the `@algorandecosystem/seed-vault/accounts` subpath. Install `@algorandfoundation/accounts-store` in applications that use it, then add `WithAccountsSeedVault` after the keystore and account-store extensions. Resolve each account address using the service binding:

```typescript
import { WithAccountsSeedVault } from "@algorandecosystem/seed-vault/accounts";

const WalletProvider = Provider.withExtensions([
  WithSeedVaultKeyStore,
  WithAccountStore,
  WithAccountsSeedVault,
]);
const provider = new WalletProvider(config, {
  ...existingOptions,
  keystore: { ...existingOptions.keystore, binding },
  accounts: {
    ...existingOptions.accounts,
    seedVault: { address: (key) => binding.address(key.id) },
  },
});
```

Vault keys without a resolved address are not added as accounts. Each added account signs transactions through the Seed Vault keystore with `intent: "transaction"`.

To request the Seed Vault's transaction confirmation UI, pass the intent through the keystore context:

```typescript
const signedTransaction = await provider.key.store.sign(
  key.id,
  unsignedTransactionBytes,
  undefined,
  { intent: "transaction" },
);
```

Signing defaults to opaque bytes. `signTransaction` returns the signed transaction bytes. Transaction batches are confirmed in chunks of at most 16; the adapter detects Seed Vault service versions older than `0.0.4` and falls back to one transaction confirmation at a time. A declined or dismissed approval becomes `SeedVaultRejectedError`; generate, import, export of private material, and removal are not supported because keys are created and managed in the vault.

## Android requirements and limitations

- React Native 0.81 or later with the New Architecture enabled; the service bridge is a TurboModule.
- Android `compileSdk` 37 and Build Tools 37, matching the published `seed-vault-sdk:0.0.4` AAR metadata. The host must build with JDK 21; Java/Kotlin output remains targeted to Java 17.
- The SDK AAR was built with Kotlin 2.4.0 and declares a minimum SDK of 34. Pera currently targets Kotlin 2.2.10 and `minSdk` 29. This module keeps the SDK dependency as `implementation`, skips only the metadata-version check while compiling this adapter, and declares `tools:overrideLibrary` for the SDK so the host can retain `minSdk` 29. The app manifest merge and the library compile have been verified in a scratch React Native host; the Kotlin metadata flag does not certify binary compatibility, and devices below API 34 need runtime validation.
- The Seed Vault service app must be installed. `authorize()` requests the dangerous `ACCESS_SEED_VAULT` Android permission and then launches the service's app-authorization screen. Each human-sign request launches the appropriate confirmation activity; automatic-sign keys are retried through confirmation if the service rejects an unattended sign for security reasons.
- On iOS or when the service app is missing, `isAvailable()` returns `false`; `ready` rejects with `SeedVaultUnavailableError`. Native signing has only been compile-verified; no service-equipped emulator or device flow is included here.
- Local signature verification for Falcon-1024 requires the optional `falcon-1024` peer dependency. Signing itself is performed by Seed Vault.

## Follow-up: shared keystore 1.0.0

This package deliberately uses the existing canary keystore contract and does not migrate Wallet Provider core types. The next design/release should:

1. Agree on the stable 1.0.0 keystore API and namespace-claim contract from the Wallet Provider design.
2. Coordinate Pera, Algorand Ecosystem Keystore, and Seed Vault on namespace ownership and collision behavior so each can add its own keys without forking core files.
3. Add cross-consumer contract tests for namespace registration, duplicate claims, key lookup, and signing, then migrate this adapter and consumers from canary peers to the stable 1.0.0 packages.
4. Publish the compatible keystore packages together with an upgrade guide; keep ledger and accounts integrations as separate work.

## License review

The repository's existing package license is MIT. The migrated source package was marked Apache-2.0, and the Android adapter links `seed-vault-sdk:0.0.4`, which is declared GPL-3.0. This release has not changed the repository license; review source notices and the SDK's copyleft implications before distributing the Android package.