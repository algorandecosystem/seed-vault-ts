package com.algorandecosystem.seedvault

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class SeedVaultServicePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == SeedVaultServiceModule.NAME) SeedVaultServiceModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
        ReactModuleInfoProvider {
            mapOf(
                SeedVaultServiceModule.NAME to
                    ReactModuleInfo(
                        SeedVaultServiceModule.NAME,
                        SeedVaultServiceModule::class.java.name,
                        false,
                        false,
                        false,
                        true,
                    ),
            )
        }
}