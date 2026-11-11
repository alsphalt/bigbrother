package com.darknote.cloud;

/** What /api/app/version reports: the live website stamp plus the newest APK. */
public class SiteVersion {
    public final String websiteVersion;
    public final int apkVersionCode;
    public final String apkVersionName;
    public final String apkDownloadUrl;

    public SiteVersion(String websiteVersion, int apkVersionCode, String apkVersionName, String apkDownloadUrl) {
        this.websiteVersion = websiteVersion;
        this.apkVersionCode = apkVersionCode;
        this.apkVersionName = apkVersionName;
        this.apkDownloadUrl = apkDownloadUrl;
    }
}
