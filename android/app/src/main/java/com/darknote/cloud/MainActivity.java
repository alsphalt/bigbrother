package com.darknote.cloud;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * Thin shell around the live site.
 *
 * The WebView always loads the deployed website, so every dashboard, setting and
 * button shipped to the site shows up here without a new APK. The APK only changes
 * when the shell itself (permissions, icon, native hooks) changes.
 */
public class MainActivity extends Activity {

    private static final String SITE = BuildConfig.BASE_URL;
    private static final String PREFS = "darknote";
    private static final String KEY_SEEN_WEBSITE = "seenWebsiteVersion";
    private static final long CHECK_INTERVAL_MS = 20_000L;

    private WebView web;
    private SwipeRefreshLayout refresh;
    private View splash;
    private View offline;
    private TextView offlineDetail;
    private SharedPreferences prefs;

    private boolean loaded = false;
    private boolean checking = false;
    private boolean dialogOpen = false;
    private long lastCheckAt = 0L;
    // Only remembered for this process: "update later" means ask again next launch.
    private String sessionDismissedWebsite = null;
    private int sessionDismissedApkCode = 0;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = findViewById(R.id.web);
        refresh = findViewById(R.id.refresh);
        splash = findViewById(R.id.splash);
        offline = findViewById(R.id.offline);
        offlineDetail = findViewById(R.id.offlineDetail);

        configureWebView();

        refresh.setColorSchemeColors(Color.parseColor("#28d9ed"), Color.parseColor("#a879ff"));
        refresh.setProgressBackgroundColorSchemeColor(Color.parseColor("#101722"));
        refresh.setOnRefreshListener(() -> loadSite(false));

        findViewById(R.id.retry).setOnClickListener(v -> loadSite(true));
        findViewById(R.id.openBrowser).setOnClickListener(v -> openExternal(SITE));

        loadSite(false);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        web.setBackgroundColor(Color.parseColor("#080b12"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " DarknoteCloud/" + BuildConfig.VERSION_NAME);

        // Cookies carry the 30-day login session; WebView keeps them across restarts.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "DarknoteApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUri(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUri(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loaded = true;
                splash.setVisibility(View.GONE);
                refresh.setRefreshing(false);
                checkForUpdates();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOffline(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame() && response != null && response.getStatusCode() >= 500) {
                    showOffline("The server answered " + response.getStatusCode() + ".");
                }
            }
        });
    }

    /** Keep the site inside the app; hand non-web links and the APK to the system. */
    private boolean handleUri(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https")) {
            openExternal(uri.toString());
            return true;
        }
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (path.startsWith("/api/app/download")) {
            // The system downloader owns the file; installing stays a user action.
            openExternal(uri.toString());
            return true;
        }
        return false;
    }

    private void loadSite(boolean force) {
        offline.setVisibility(View.GONE);
        if (!isOnline()) {
            showOffline("No internet connection.");
            return;
        }
        splash.setVisibility(View.VISIBLE);
        if (force) {
            web.clearCache(true);
        }
        if (loaded) {
            web.reload();
        } else {
            web.loadUrl(SITE);
        }
    }

    private void reloadFresh() {
        splash.setVisibility(View.VISIBLE);
        offline.setVisibility(View.GONE);
        web.clearCache(true);
        web.loadUrl(SITE + "/?v=" + System.currentTimeMillis());
        Toast.makeText(this, "Loading the latest version…", Toast.LENGTH_SHORT).show();
    }

    private void showOffline(String reason) {
        splash.setVisibility(View.GONE);
        refresh.setRefreshing(false);
        offlineDetail.setText(reason == null || reason.isEmpty()
                ? "Check your connection and try again."
                : reason);
        offline.setVisibility(View.VISIBLE);
    }

    private void checkForUpdates() {
        if (checking || !loaded) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastCheckAt < CHECK_INTERVAL_MS) {
            return;
        }
        checking = true;
        lastCheckAt = now;
        VersionChecker.check(SITE, (version, error) -> {
            checking = false;
            if (version == null) {
                return; // offline or endpoint missing; the page already explains itself
            }
            handleVersion(version);
        });
    }

    private void handleVersion(SiteVersion version) {
        if (dialogOpen) {
            return;
        }
        String seen = prefs.getString(KEY_SEEN_WEBSITE, null);
        UpdatePolicy.Action action = UpdatePolicy.decide(
                seen,
                version.websiteVersion,
                BuildConfig.VERSION_CODE,
                version.apkVersionCode,
                sessionDismissedWebsite,
                sessionDismissedApkCode);

        switch (action) {
            case ADOPT_BASELINE:
                // Fresh install: adopt the current stamp so the first launch stays quiet.
                if (version.websiteVersion != null) {
                    prefs.edit().putString(KEY_SEEN_WEBSITE, version.websiteVersion).apply();
                }
                break;
            case WEBSITE:
                promptWebsiteUpdate(version.websiteVersion);
                break;
            case APK:
                promptApkUpdate(version);
                break;
            default:
                break;
        }
    }

    private void promptWebsiteUpdate(final String version) {
        dialogOpen = true;
        new AlertDialog.Builder(this)
                .setTitle("NEW VERSION AVAILABLE")
                .setMessage("A new Darknote Cloud update is ready!")
                .setPositiveButton("UPDATE NOW", (dialog, which) -> {
                    dialogOpen = false;
                    prefs.edit().putString(KEY_SEEN_WEBSITE, version).apply();
                    reloadFresh();
                })
                .setNegativeButton("UPDATE LATER", (dialog, which) -> {
                    dialogOpen = false;
                    sessionDismissedWebsite = version;
                })
                .setOnDismissListener(dialog -> dialogOpen = false)
                .show();
    }

    private void promptApkUpdate(final SiteVersion version) {
        dialogOpen = true;
        String label = version.apkVersionName == null ? "A newer build" : "Version " + version.apkVersionName;
        new AlertDialog.Builder(this)
                .setTitle("APP UPDATE AVAILABLE")
                .setMessage(label + " is ready. Download the APK, then tap Install — Android asks you to allow it. "
                        + "Your login and website data stay exactly as they are.")
                .setPositiveButton("DOWNLOAD", (dialog, which) -> {
                    dialogOpen = false;
                    sessionDismissedApkCode = version.apkVersionCode;
                    openExternal(SITE + "/api/app/download");
                })
                .setNegativeButton("LATER", (dialog, which) -> {
                    dialogOpen = false;
                    sessionDismissedApkCode = version.apkVersionCode;
                })
                .setOnDismissListener(dialog -> dialogOpen = false)
                .show();
    }

    @SuppressWarnings("deprecation")
    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) {
            return true;
        }
        NetworkInfo info = manager.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app can open that link.", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
        checkForUpdates();
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }

    /** Exposed to the site as window.DarknoteApp so the page can adapt its UI. */
    public class Bridge {
        @JavascriptInterface
        public String getVersionName() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public int getVersionCode() {
            return BuildConfig.VERSION_CODE;
        }

        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> reloadFresh());
        }

        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> {
                lastCheckAt = 0L;
                checkForUpdates();
            });
        }

        @JavascriptInterface
        public void openExternalUrl(String url) {
            runOnUiThread(() -> openExternal(url));
        }
    }
}
