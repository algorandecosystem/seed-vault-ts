package com.algorandecosystem.seedvault

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.algorandecosystem.seedvault.NativeSeedVaultServiceSpec
import com.michaeltchuang.seedvault.sdk.SeedVaultServiceConstants
import com.michaeltchuang.seedvault.sdk.client.SeedVaultServiceClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class SeedVaultServiceModule(
    private val reactContext: ReactApplicationContext,
) : NativeSeedVaultServiceSpec(reactContext), ActivityEventListener {
    private val client = SeedVaultServiceClient(reactContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pendingActivityPromises = ConcurrentHashMap<Int, Promise>()
    private val nextRequestCode = AtomicInteger(REQUEST_CODE_START)

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = NAME

    override fun isAvailable(promise: Promise) {
        promise.resolve(isServiceInstalled())
    }

    override fun isBatchSupported(promise: Promise) {
        promise.resolve(hasBatchConfirmationSupport())
    }

    override fun getAuthorizedSeeds(promise: Promise) {
        launchServiceCall(promise) {
            val seeds = client.getAuthorizedSeeds()
            JSONArray().apply {
                seeds.forEach { seed ->
                    put(
                        JSONObject().apply {
                            put("id", seed.id.toString())
                            put("name", seed.name)
                            put(
                                "accounts",
                                JSONArray().apply {
                                    seed.accounts.forEach { account ->
                                        put(
                                            JSONObject().apply {
                                                put("index", account.index)
                                                put("address", account.address)
                                                put("publicKey", account.publicKey)
                                                put("isAutosign", account.isAutosign)
                                                put("requiresApproval", account.requiresApproval)
                                            },
                                        )
                                    }
                                },
                            )
                        },
                    )
                }
            }.toString()
        }
    }

    override fun authorize(promise: Promise) {
        if (!isServiceInstalled()) {
            reject(promise, IllegalStateException("Seed Vault service is not installed"))
            return
        }

        val activity = reactContext.currentActivity
        if (activity == null) {
            reject(promise, IllegalStateException("A foreground activity is required to authorize Seed Vault"))
            return
        }

        requestAccessPermission(activity, promise) { granted ->
            if (granted) {
                launchForResult(client.authorizeAppIntent(), promise)
            } else {
                promise.resolve(false)
            }
        }
    }

    override fun confirmSignBytes(address: String, data: String, promise: Promise) {
        launchForResult(
            client.confirmSignBytesIntent(address, decode(data)),
            promise,
        )
    }

    override fun confirmSignTransaction(address: String, transaction: String, promise: Promise) {
        launchForResult(
            client.confirmSignTransactionIntent(address, decode(transaction)),
            promise,
        )
    }

    override fun confirmSignTransactions(address: String, transactions: String, promise: Promise) {
        try {
            val encodedTransactions = JSONArray(transactions)
            val decodedTransactions = (0 until encodedTransactions.length()).map { index ->
                decode(encodedTransactions.getString(index))
            }
            launchForResult(
                client.confirmSignTransactionsIntent(address, decodedTransactions),
                promise,
            )
        } catch (error: Exception) {
            reject(promise, error)
        }
    }

    override fun signBytes(address: String, data: String, promise: Promise) {
        launchServiceCall(promise) {
            client.signBytes(address, decode(data))?.let { encode(it) }
        }
    }

    override fun signTransaction(address: String, transaction: String, promise: Promise) {
        launchServiceCall(promise) {
            client.signTransaction(address, decode(transaction))?.let { encode(it) }
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        pendingActivityPromises.remove(requestCode)?.resolve(resultCode == Activity.RESULT_OK)
    }

    override fun onNewIntent(intent: Intent) = Unit

    override fun invalidate() {
        reactContext.removeActivityEventListener(this)
        client.unbind()
        scope.cancel()
        pendingActivityPromises.values.forEach { promise ->
            promise.reject("E_SEED_VAULT_UNAVAILABLE", "React Native context was invalidated")
        }
        pendingActivityPromises.clear()
        super.invalidate()
    }

    private fun isServiceInstalled(): Boolean =
        try {
            @Suppress("DEPRECATION")
            reactContext.packageManager.getPackageInfo(SeedVaultServiceConstants.PACKAGE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }

    private fun hasBatchConfirmationSupport(): Boolean {
        val versionName =
            try {
                @Suppress("DEPRECATION")
                reactContext.packageManager
                    .getPackageInfo(SeedVaultServiceConstants.PACKAGE, 0)
                    .versionName
            } catch (_: PackageManager.NameNotFoundException) {
                return false
            }
        val parts = versionName?.trimStart('v')?.substringBefore('-')?.substringBefore('+')?.split('.') ?: return false
        if (parts.size < 3) return false
        val version = IntArray(3)
        for (index in 0..2) version[index] = parts[index].toIntOrNull() ?: return false
        val minimum = intArrayOf(0, 0, 4)
        for (index in 0..2) {
            if (version[index] != minimum[index]) return version[index] > minimum[index]
        }
        return true
    }

    private fun requestAccessPermission(
        activity: Activity,
        promise: Promise,
        onResult: (Boolean) -> Unit,
    ) {
        val permission = SeedVaultServiceConstants.PERMISSION_ACCESS_SEED_VAULT
        if (activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            onResult(true)
            return
        }

        val permissionAwareActivity = activity as? PermissionAwareActivity
        if (permissionAwareActivity == null) {
            reject(promise, IllegalStateException("The current activity cannot request Android permissions"))
            return
        }

        val requestCode = nextRequestCode.getAndIncrement()
        permissionAwareActivity.requestPermissions(
            arrayOf(permission),
            requestCode,
            PermissionListener { resultCode, _, grantResults ->
                if (resultCode != requestCode) {
                    false
                } else {
                    onResult(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
                    true
                }
            },
        )
    }

    private fun launchForResult(intent: Intent, promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            reject(promise, IllegalStateException("A foreground activity is required for Seed Vault"))
            return
        }

        val requestCode = nextRequestCode.getAndIncrement()
        pendingActivityPromises[requestCode] = promise
        UiThreadUtil.runOnUiThread {
            try {
                activity.startActivityForResult(intent, requestCode)
            } catch (error: Exception) {
                pendingActivityPromises.remove(requestCode)
                reject(promise, error)
            }
        }
    }

    private fun launchServiceCall(promise: Promise, operation: suspend () -> Any?) {
        scope.launch {
            try {
                client.bindAsync()
                promise.resolve(operation())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                reject(promise, error)
            }
        }
    }

    private fun decode(value: String): ByteArray = Base64.decode(value, Base64.DEFAULT)

    private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)

    private fun reject(promise: Promise, error: Exception) {
        val code = when (error) {
            is SecurityException -> ERROR_SECURITY
            is IllegalArgumentException -> ERROR_INVALID_REQUEST
            else -> ERROR_UNAVAILABLE
        }
        promise.reject(code, error.message, error)
    }

    companion object {
        const val NAME = "SeedVaultService"
        private const val REQUEST_CODE_START = 0x5E00
        private const val ERROR_SECURITY = "E_SEED_VAULT_SECURITY"
        private const val ERROR_INVALID_REQUEST = "E_SEED_VAULT_INVALID_REQUEST"
        private const val ERROR_UNAVAILABLE = "E_SEED_VAULT_UNAVAILABLE"
    }
}