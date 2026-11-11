package com.darknote.cloud;

/**
 * The decision behind the update prompts, kept free of Android types so it can be
 * unit-tested on a plain JVM.
 */
public final class UpdatePolicy {

    public enum Action {
        /** Nothing to do. */
        NONE,
        /** First launch: remember the current stamp, never prompt. */
        ADOPT_BASELINE,
        /** The website moved on — offer a reload. */
        WEBSITE,
        /** A newer APK exists — offer the download. */
        APK
    }

    private UpdatePolicy() {
    }

    /**
     * @param seenWebsite      stamp stored by the last accepted website version, null on first run
     * @param currentWebsite   stamp reported by the server
     * @param appVersionCode   versionCode of the installed APK
     * @param remoteApkCode    versionCode of the newest published APK, 0 when unknown
     * @param dismissedWebsite site stamp the user chose to postpone this session
     * @param dismissedApkCode APK versionCode the user chose to postpone this session
     */
    public static Action decide(String seenWebsite, String currentWebsite, int appVersionCode,
                                int remoteApkCode, String dismissedWebsite, int dismissedApkCode) {
        if (seenWebsite == null) {
            return Action.ADOPT_BASELINE;
        }
        if (currentWebsite != null
                && !currentWebsite.isEmpty()
                && !currentWebsite.equals(seenWebsite)
                && !currentWebsite.equals(dismissedWebsite)) {
            return Action.WEBSITE;
        }
        if (remoteApkCode > appVersionCode && remoteApkCode > dismissedApkCode) {
            return Action.APK;
        }
        return Action.NONE;
    }
}
