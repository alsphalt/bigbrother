# The JavaScript bridge is looked up by name from web content.
-keepclassmembers class com.darknote.cloud.MainActivity$Bridge {
    public *;
}
-keepattributes JavascriptInterface
