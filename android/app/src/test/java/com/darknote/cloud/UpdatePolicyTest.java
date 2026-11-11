package com.darknote.cloud;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class UpdatePolicyTest {

    @Test
    public void firstRunAdoptsBaselineWithoutPrompting() {
        assertEquals(UpdatePolicy.Action.ADOPT_BASELINE,
                UpdatePolicy.decide(null, "abc123", 101, 101, null, 0));
    }

    @Test
    public void unchangedWebsiteDoesNotPrompt() {
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "abc123", 101, 101, null, 0));
    }

    @Test
    public void newWebsiteVersionPrompts() {
        assertEquals(UpdatePolicy.Action.WEBSITE,
                UpdatePolicy.decide("abc123", "def456", 101, 101, null, 0));
    }

    @Test
    public void updateLaterIsRememberedForThisSessionOnly() {
        // dismissed for the session -> quiet
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "def456", 101, 101, "def456", 0));
        // a newer deployment still prompts
        assertEquals(UpdatePolicy.Action.WEBSITE,
                UpdatePolicy.decide("abc123", "789ghi", 101, 101, "def456", 0));
    }

    @Test
    public void newerApkPromptsWhenWebsiteIsCurrent() {
        assertEquals(UpdatePolicy.Action.APK,
                UpdatePolicy.decide("abc123", "abc123", 101, 104, null, 0));
    }

    @Test
    public void websitePromptTakesPriorityOverApkPrompt() {
        assertEquals(UpdatePolicy.Action.WEBSITE,
                UpdatePolicy.decide("abc123", "def456", 101, 104, null, 0));
    }

    @Test
    public void apkPromptStaysQuietOncePostponed() {
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "abc123", 101, 104, null, 104));
    }

    @Test
    public void olderOrEqualApkNeverPrompts() {
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "abc123", 104, 104, null, 0));
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "abc123", 104, 0, null, 0));
    }

    @Test
    public void missingWebsiteStampNeverTriggersReload() {
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", null, 101, 101, null, 0));
        assertEquals(UpdatePolicy.Action.NONE,
                UpdatePolicy.decide("abc123", "", 101, 101, null, 0));
    }
}
