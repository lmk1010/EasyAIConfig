package com.easyaiconfig.easy_ai_config

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// 关键修复：当手机同时连着「无外网的局域网 WiFi」和「移动数据」时，
/// 系统默认网络会是蜂窝，App 的 socket 走 4G → 到不了内网电脑（连接超时）。
/// 这里请求 WiFi 传输的网络并把本进程绑定到它，强制 App 走 WiFi 访问内网。
/// 提供 bindWifi / unbind 两个方法：连内网(局域网/VPS 走 WiFi 直连)时绑 WiFi，
/// 走 VPS 公网(需要蜂窝)时解绑。
class MainActivity : FlutterActivity() {
    private val channel = "easyaiconfig/net"
    private var cm: ConnectivityManager? = null
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "bindWifi" -> {
                        bindWifi()
                        result.success(true)
                    }
                    "unbind" -> {
                        unbind()
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onResume() {
        super.onResume()
        // 默认就尝试绑 WiFi —— 本 App 主要用于同 WiFi 远程，绑定后内网直连不再被 4G 抢路由。
        bindWifi()
    }

    override fun onDestroy() {
        unbind()
        super.onDestroy()
    }

    private fun bindWifi() {
        val manager = cm ?: return
        // 已经绑了就不重复请求
        if (wifiCallback != null) return
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                try {
                    manager.bindProcessToNetwork(network)
                } catch (_: Throwable) {}
            }
            override fun onLost(network: Network) {
                try {
                    manager.bindProcessToNetwork(null)
                } catch (_: Throwable) {}
            }
        }
        wifiCallback = cb
        try {
            manager.requestNetwork(req, cb)
        } catch (_: Throwable) {
            wifiCallback = null
        }
    }

    private fun unbind() {
        val manager = cm ?: return
        try {
            manager.bindProcessToNetwork(null)
        } catch (_: Throwable) {}
        wifiCallback?.let {
            try {
                manager.unregisterNetworkCallback(it)
            } catch (_: Throwable) {}
        }
        wifiCallback = null
    }
}
