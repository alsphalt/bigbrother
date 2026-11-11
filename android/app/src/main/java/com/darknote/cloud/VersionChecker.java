package com.darknote.cloud;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Fetches /api/app/version off the main thread and hands the result back on it. */
public final class VersionChecker {

    public interface Callback {
        void onResult(SiteVersion version, String error);
    }

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private VersionChecker() {
    }

    public static void check(final String baseUrl, final Callback callback) {
        POOL.execute(new Runnable() {
            @Override
            public void run() {
                SiteVersion parsed = null;
                String failure = null;
                HttpURLConnection connection = null;
                try {
                    URL url = new URL(baseUrl + "/api/app/version");
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setConnectTimeout(8000);
                    connection.setReadTimeout(8000);
                    connection.setRequestProperty("Accept", "application/json");
                    connection.setRequestProperty("User-Agent", "DarknoteCloud/" + BuildConfig.VERSION_NAME);
                    int status = connection.getResponseCode();
                    if (status != 200) {
                        throw new IllegalStateException("HTTP " + status);
                    }
                    StringBuilder body = new StringBuilder();
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
                    try {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            body.append(line);
                        }
                    } finally {
                        reader.close();
                    }
                    JSONObject root = new JSONObject(body.toString());
                    JSONObject site = root.optJSONObject("website");
                    JSONObject apk = root.optJSONObject("apk");
                    parsed = new SiteVersion(
                            site == null ? null : site.optString("version", null),
                            apk == null ? 0 : apk.optInt("versionCode", 0),
                            apk == null ? null : apk.optString("versionName", null),
                            apk == null ? null : apk.optString("downloadUrl", null));
                } catch (Exception e) {
                    failure = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                } finally {
                    if (connection != null) {
                        connection.disconnect();
                    }
                }

                final SiteVersion result = parsed;
                final String message = failure;
                MAIN.post(new Runnable() {
                    @Override
                    public void run() {
                        callback.onResult(result, message);
                    }
                });
            }
        });
    }
}
