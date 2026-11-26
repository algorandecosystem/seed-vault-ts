export default {
  dependency: {
    platforms: {
      android: {
        sourceDir: "./android",
        packageImportPath: "import com.algorandecosystem.seedvault.SeedVaultServicePackage;",
        packageInstance: "new SeedVaultServicePackage()",
      },
      ios: null,
    },
  },
};