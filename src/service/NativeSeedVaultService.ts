import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  isAvailable(): Promise<boolean>;
  isBatchSupported(): Promise<boolean>;
  getAuthorizedSeeds(): Promise<string>;
  authorize(): Promise<boolean>;
  confirmSignBytes(address: string, data: string): Promise<boolean>;
  confirmSignTransaction(address: string, transaction: string): Promise<boolean>;
  confirmSignTransactions(address: string, transactions: string): Promise<boolean>;
  signBytes(address: string, data: string): Promise<string | null>;
  signTransaction(address: string, transaction: string): Promise<string | null>;
}

export type SeedVaultServiceModule = Omit<Spec, "confirmSignTransactions" | "isBatchSupported"> & {
  isBatchSupported?(): Promise<boolean>;
  confirmSignTransactions?(address: string, transactions: string): Promise<boolean>;
};

const NativeSeedVaultService: Spec | null = TurboModuleRegistry.get<Spec>("SeedVaultService");

export default NativeSeedVaultService;